import CoreGraphics
import XCTest
@testable import photofilter

final class PeopleSubjectClassifierTests: XCTestCase {
    private enum StubFailure: Error {
        case unavailable
    }

    func testOptionalFailuresPreservePrimaryEvidence() {
        let human = PeopleSubjectRegion(
            boundingBox: CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.8),
            confidence: 0.91
        )
        let face = PeopleFaceEvidence(
            boundingBox: CGRect(x: 0.35, y: 0.55, width: 0.2, height: 0.2),
            captureQuality: 0.82,
            yawRadians: 0
        )
        let mask = PeoplePersonMaskEvidence(
            coverage: 0.31,
            boundingBox: human.boundingBox
        )
        var attempted: [String] = []

        let evidence = PhotoCategoryClassifier.collectEvidence(
            humanRegions: {
                attempted.append("human")
                return [human]
            },
            faces: {
                attempted.append("face")
                return [face]
            },
            personMask: {
                attempted.append("segmentation")
                return mask
            },
            personInstanceCount: {
                attempted.append("instances")
                throw StubFailure.unavailable
            },
            salientRegions: {
                attempted.append("saliency")
                throw StubFailure.unavailable
            }
        )

        XCTAssertEqual(
            attempted,
            ["human", "face", "segmentation", "instances", "saliency"]
        )
        XCTAssertEqual(evidence.humanRegions, [human])
        XCTAssertEqual(evidence.faces, [face])
        XCTAssertEqual(evidence.personMaskCoverage, mask.coverage)
        XCTAssertEqual(evidence.personMaskBoundingBox, mask.boundingBox)
        XCTAssertEqual(evidence.personInstanceCount, 0)
        XCTAssertTrue(evidence.salientRegions.isEmpty)
        XCTAssertEqual(
            PeopleSubjectEvaluator.classify(evidence).category,
            .people
        )
    }

    func testPrimaryFailureDoesNotPreventRemainingDetectors() {
        let face = PeopleFaceEvidence(
            boundingBox: CGRect(x: 0.3, y: 0.45, width: 0.3, height: 0.3),
            captureQuality: 0.75,
            yawRadians: 0.1
        )
        let mask = PeoplePersonMaskEvidence(
            coverage: 0.2,
            boundingBox: CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.8)
        )
        let salient = CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.8)
        var attempted: [String] = []

        let evidence = PhotoCategoryClassifier.collectEvidence(
            humanRegions: {
                attempted.append("human")
                throw StubFailure.unavailable
            },
            faces: {
                attempted.append("face")
                return [face]
            },
            personMask: {
                attempted.append("segmentation")
                return mask
            },
            personInstanceCount: {
                attempted.append("instances")
                return 1
            },
            salientRegions: {
                attempted.append("saliency")
                return [salient]
            }
        )

        XCTAssertEqual(
            attempted,
            ["human", "face", "segmentation", "instances", "saliency"]
        )
        XCTAssertTrue(evidence.humanRegions.isEmpty)
        XCTAssertEqual(evidence.faces, [face])
        XCTAssertEqual(evidence.personMaskCoverage, mask.coverage)
        XCTAssertEqual(evidence.personInstanceCount, 1)
        XCTAssertEqual(evidence.salientRegions, [salient])
        XCTAssertEqual(
            PeopleSubjectEvaluator.classify(evidence).category,
            .people
        )
    }

    func testSaliencyIsSkippedWhenNoPersonMaskExists() {
        var saliencyWasAttempted = false

        let evidence = PhotoCategoryClassifier.collectEvidence(
            humanRegions: { [] },
            faces: { [] },
            personMask: { nil },
            personInstanceCount: { 0 },
            salientRegions: {
                saliencyWasAttempted = true
                return [CGRect(x: 0, y: 0, width: 1, height: 1)]
            }
        )

        XCTAssertFalse(saliencyWasAttempted)
        XCTAssertTrue(evidence.salientRegions.isEmpty)
    }
}
