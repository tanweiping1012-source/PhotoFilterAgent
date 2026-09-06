import CoreGraphics
import Foundation
import XCTest
@testable import photofilter

final class VerifiedImageSourceTests: XCTestCase {
    func testReturnsTheExactBytesThatWereHashed() throws {
        let fixture = try fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let original = try Data(contentsOf: fixture.image)
        let index = AnonymousIndex(
            root: fixture.root.path,
            byAnonymous: ["p001": fixture.image.path]
        )

        let loaded = try VerifiedImageSource.load(
            id: "p001",
            index: index,
            expectedSHA256: VerifiedImageSource.sha256(original)
        )

        XCTAssertEqual(loaded, original)
        XCTAssertNoThrow(try AIReviewPreviewEncoder.jpegData(for: loaded, maximumPixelSize: 32))
    }

    func testRejectsSymlinkOutsideAuthorizedRootEvenWhenHashMatches() throws {
        let fixture = try fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let outsideRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-outside-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outsideRoot) }
        let outside = outsideRoot.appendingPathComponent("outside.jpg")
        let outsideData = try Data(contentsOf: fixture.image)
        try outsideData.write(to: outside)
        let swapped = fixture.root.appendingPathComponent("p001.jpg")
        try FileManager.default.createSymbolicLink(at: swapped, withDestinationURL: outside)
        let index = AnonymousIndex(root: fixture.root.path, byAnonymous: ["p001": swapped.path])

        XCTAssertThrowsError(try VerifiedImageSource.load(
            id: "p001",
            index: index,
            expectedSHA256: VerifiedImageSource.sha256(outsideData)
        )) { error in
            XCTAssertEqual(error as? VerifiedImageSourceError, .outsideAuthorizedRoot)
        }
    }

    func testRejectsInRootReplacementWhoseBytesNoLongerMatch() throws {
        let fixture = try fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let original = try Data(contentsOf: fixture.image)
        let frozenHash = VerifiedImageSource.sha256(original)
        var replacement = original
        replacement.append(0)
        try replacement.write(to: fixture.image, options: .atomic)
        let index = AnonymousIndex(
            root: fixture.root.path,
            byAnonymous: ["p001": fixture.image.path]
        )

        XCTAssertThrowsError(try VerifiedImageSource.load(
            id: "p001", index: index, expectedSHA256: frozenHash
        )) { error in
            XCTAssertEqual(error as? VerifiedImageSourceError, .contentIdentityChanged)
        }
    }

    func testInvalidHashFailsBeforeReadingSource() {
        let index = AnonymousIndex(root: "/does-not-exist", byAnonymous: ["p001": "/private.jpg"])

        XCTAssertThrowsError(try VerifiedImageSource.load(
            id: "p001", index: index, expectedSHA256: "not-a-hash"
        )) { error in
            XCTAssertEqual(error as? VerifiedImageSourceError, .invalidExpectedSHA256)
        }
    }

    private func fixture() throws -> (root: URL, image: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-verified-source-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let imageURL = root.appendingPathComponent("source.jpg")
        try AIReviewPreviewEncoder.jpegData(for: try solidImage()).write(to: imageURL)
        return (root, imageURL)
    }

    private func solidImage() throws -> CGImage {
        guard let context = CGContext(
            data: nil,
            width: 32,
            height: 24,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        context.setFillColor(CGColor(red: 0.3, green: 0.6, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 24))
        guard let image = context.makeImage() else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        return image
    }
}
