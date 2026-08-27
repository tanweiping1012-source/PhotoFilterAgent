import Foundation
import XCTest
@testable import photofilter

final class ExportSafetyTests: XCTestCase {
    private func fixture() throws -> (root: URL, source: URL, destination: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-export-safety-\(UUID().uuidString)", isDirectory: true)
        let source = root.appendingPathComponent("source", isDirectory: true)
        let destination = root.appendingPathComponent("destination", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        return (root, source, destination)
    }

    func testRejectsSourceRootAndItsDescendantAsDestination() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let photo = value.source.appendingPathComponent("candidate.jpg")
        try Data("synthetic".utf8).write(to: photo)
        let index = ["p001": photo.path]

        XCTAssertThrowsError(try ExportSafety.makePlan(
            sourceRoot: value.source.path,
            byAnonymous: index,
            ids: ["p001"],
            destination: value.source.path
        )) { error in
            XCTAssertEqual(error as? ExportSafetyError, .destinationInsideSourceRoot)
        }

        let child = value.source.appendingPathComponent("export", isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        XCTAssertThrowsError(try ExportSafety.makePlan(
            sourceRoot: value.source.path,
            byAnonymous: index,
            ids: ["p001"],
            destination: child.path
        )) { error in
            XCTAssertEqual(error as? ExportSafetyError, .destinationInsideSourceRoot)
        }
    }

    func testExistingDestinationFailsWithoutChangingItsBytes() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let photo = value.source.appendingPathComponent("candidate.jpg")
        let target = value.destination.appendingPathComponent("candidate.jpg")
        try Data("new-source".utf8).write(to: photo)
        try Data("existing-target".utf8).write(to: target)

        XCTAssertThrowsError(try ExportSafety.makePlan(
            sourceRoot: value.source.path,
            byAnonymous: ["p001": photo.path],
            ids: ["p001"],
            destination: value.destination.path
        )) { error in
            XCTAssertEqual(error as? ExportSafetyError, .destinationAlreadyExists("p001"))
        }
        XCTAssertEqual(try Data(contentsOf: target), Data("existing-target".utf8))
    }

    func testDuplicateBasenamesFailDuringPreflight() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let firstDir = value.source.appendingPathComponent("a", isDirectory: true)
        let secondDir = value.source.appendingPathComponent("b", isDirectory: true)
        try FileManager.default.createDirectory(at: firstDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: secondDir, withIntermediateDirectories: true)
        let first = firstDir.appendingPathComponent("same.jpg")
        let second = secondDir.appendingPathComponent("same.jpg")
        try Data("one".utf8).write(to: first)
        try Data("two".utf8).write(to: second)

        XCTAssertThrowsError(try ExportSafety.makePlan(
            sourceRoot: value.source.path,
            byAnonymous: ["p001": first.path, "p002": second.path],
            ids: ["p001", "p002"],
            destination: value.destination.path
        )) { error in
            XCTAssertEqual(error as? ExportSafetyError, .duplicateDestinationName("p002"))
        }
        XCTAssertTrue((try FileManager.default.contentsOfDirectory(atPath: value.destination.path)).isEmpty)
    }
}
