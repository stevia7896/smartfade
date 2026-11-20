import Foundation
import CoreAudio

let smartFadeVersion = "0.6.2"

private let logFormatter: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f
}()
private let logLock = NSLock()
private let logHandle: FileHandle? = {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/SmartFade.log")
    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
    let h = try? FileHandle(forWritingTo: url)
    _ = try? h?.seekToEnd()
    return h
}()
private let toTerminal = isatty(STDOUT_FILENO) != 0

/// Appends to ~/Library/Logs/SmartFade.log; also prints when run from a terminal.
func log(_ s: String) {
    let line = "[\(logFormatter.string(from: Date()))] \(s)\n"
    logLock.lock(); defer { logLock.unlock() }
    logHandle?.write(line.data(using: .utf8)!)
    if toTerminal { print(line, terminator: "") }
}

func address(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func getProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = address(sel)
    var size = UInt32(MemoryLayout<T>.size)
    var value = initial
    let err = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
    return err == noErr ? value : nil
}

func getString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    getProp(obj, sel, "" as CFString).map { $0 as String }
}

func getIDs(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
    var addr = address(sel)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func spotifyProcesses() -> [AudioObjectID] {
    getIDs(systemObject, kAudioHardwarePropertyProcessObjectList).filter {
        (getString($0, kAudioProcessPropertyBundleID) ?? "").hasPrefix("com.spotify.client")
    }.sorted()
}

func defaultOutputDevice() -> AudioDeviceID? {
    getProp(systemObject, kAudioHardwarePropertyDefaultOutputDevice, AudioDeviceID(0)).flatMap { $0 == 0 ? nil : $0 }
}
