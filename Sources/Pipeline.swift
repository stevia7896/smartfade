import Foundation
import CoreAudio
import AudioToolbox

/// Spotify process tap + private aggregate device + IOProc. Rebuilt by main when Spotify restarts or the output device changes.
final class Pipeline {
    let dsp: DSP
    private(set) var procs: [AudioObjectID] = []
    private(set) var outDev: AudioDeviceID = 0
    private(set) var outName = ""
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var overloadListener: AudioObjectPropertyListenerBlock?
    private let ioQueue = DispatchQueue(label: "smartfade.io", qos: .userInteractive)

    var running: Bool { procID != nil }

    init(dsp: DSP) { self.dsp = dsp }

    func start(procs: [AudioObjectID], output: AudioDeviceID) -> Bool {
        stop()
        guard let outUID = getString(output, kAudioDevicePropertyDeviceUID) else { log("✗ Cannot read output device UID"); return false }

        let desc = CATapDescription(stereoMixdownOfProcesses: procs)
        desc.uuid = UUID()
        desc.name = "SmartFade Tap"
        desc.isPrivate = true
        desc.muteBehavior = .mutedWhenTapped

        var err = AudioHardwareCreateProcessTap(desc, &tapID)
        guard err == noErr else { log("✗ Failed to create process tap \(err) — check System Audio Recording permission"); tapID = 0; return false }

        let dict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "SmartFade",
            kAudioAggregateDeviceUIDKey: "local.smartfade.aggregate." + UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        err = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggID)
        guard err == noErr else { log("✗ Failed to create aggregate device \(err)"); stop(); return false }

        let sr = getProp(aggID, kAudioDevicePropertyNominalSampleRate, Float64(0)) ?? 48000
        dsp.configure(sampleRate: sr > 0 ? sr : 48000)

        let dsp = self.dsp
        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, ioQueue) { _, inData, _, outData, _ in
            dsp.process(input: UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData)),
                        output: UnsafeMutableAudioBufferListPointer(outData))
        }
        guard err == noErr else { log("✗ Failed to create IOProc \(err)"); procID = nil; stop(); return false }
        err = AudioDeviceStart(aggID, procID)
        guard err == noErr else { log("✗ Failed to start device \(err)"); stop(); return false }

        // xrun (processing overload) detection
        var ovAddr = address(kAudioDeviceProcessorOverload)
        let listener: AudioObjectPropertyListenerBlock = { _, _ in log("⚠️ Audio overload (xrun) — a glitch may be audible") }
        if AudioObjectAddPropertyListenerBlock(aggID, &ovAddr, DispatchQueue.main, listener) == noErr { overloadListener = listener }

        self.procs = procs
        self.outDev = output
        self.outName = getString(output, kAudioObjectPropertyName) ?? "?"
        log("✓ Processing Spotify audio → \(outName) @ \(Int(sr)) Hz")
        return true
    }

    func stop() {
        if let p = procID {
            AudioDeviceStop(aggID, p)
            AudioDeviceDestroyIOProcID(aggID, p)
            procID = nil
        }
        if let l = overloadListener, aggID != kAudioObjectUnknown {
            var ovAddr = address(kAudioDeviceProcessorOverload)
            AudioObjectRemovePropertyListenerBlock(aggID, &ovAddr, DispatchQueue.main, l)
            overloadListener = nil
        }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID); aggID = AudioObjectID(kAudioObjectUnknown) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = AudioObjectID(kAudioObjectUnknown) }
        procs = []; outDev = 0
    }
}
