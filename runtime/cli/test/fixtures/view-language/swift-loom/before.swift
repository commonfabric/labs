import Foundation
import ImageIO
import Vision

// Source-side helper for one bounded USPS digest. The Python caller supplies
// verified temporary images, consumes this JSON in memory, and deletes the
// files before returning a minimized interpretation to the daemon.
var output: [String] = []

for rawPath in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: rawPath)
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fputs("unreadable image\n", stderr)
        exit(2)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fputs("vision request failed\n", stderr)
        exit(3)
    }
    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string
    }
    output.append(lines.joined(separator: "\n"))
}

do {
    let data = try JSONSerialization.data(withJSONObject: output, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fputs("could not encode vision result\n", stderr)
    exit(4)
}
