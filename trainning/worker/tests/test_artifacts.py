from __future__ import annotations

import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from worker.artifacts import ArtifactPublisher
from worker.pipeline import JobPaths, PipelineResult
from worker.storage import FilesystemObjectStorage
from worker.tests.helpers import execution_spec


class ArtifactTests(unittest.TestCase):
    def test_publishes_archive_manifest_log_and_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = execution_spec()
            paths = JobPaths.create(root / "jobs", spec)
            result_dir = paths.result_root / "model"
            result_dir.mkdir(parents=True)
            (result_dir / "weights.npy").write_bytes(b"weights")
            (result_dir / "metrics.json").write_text(
                json.dumps({"npmi": 0.42}), encoding="utf-8"
            )
            paths.log_file.write_text("training output", encoding="utf-8")
            object_root = root / "objects"
            bundle = ArtifactPublisher(FilesystemObjectStorage(object_root)).publish(
                spec, PipelineResult(result_dir, paths, 1.25)
            )

            archive = object_root / Path(*bundle.model_weights_path.split("/"))
            manifest = object_root / "training-results" / "42" / "attempt-1" / "manifest.json"
            self.assertTrue(archive.is_file())
            self.assertTrue(manifest.is_file())
            self.assertEqual(bundle.metrics["npmi"], 0.42)
            with tarfile.open(archive, "r:gz") as value:
                self.assertIn("result/weights.npy", value.getnames())


if __name__ == "__main__":
    unittest.main()
