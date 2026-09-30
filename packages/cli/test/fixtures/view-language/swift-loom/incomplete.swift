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
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fputs("vision request failed\n", stderr)
        exit(3)
    }
    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.