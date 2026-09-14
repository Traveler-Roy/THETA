from __future__ import annotations

import json
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .pipeline import PipelineResult
from .protocol import ExecutionSpec
from .storage import ObjectStorage, sha256_file


SELECTED_SUFFIXES = {".json", ".csv", ".txt", ".png", ".html"}
MAX_SELECTED_FILE_BYTES = 50 * 1024 * 1024


@dataclass(frozen=True)
class ArtifactBundle:
    model_weights_path: str
    metrics: dict[str, Any]
    output_files: dict[str, Any]


class ArtifactPublisher:
    def __init__(self, storage: ObjectStorage):
        self.storage = storage

    def publish(self, spec: ExecutionSpec, result: PipelineResult) -> ArtifactBundle:
        artifact_dir = result.paths.root / "artifacts"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        archive_path = artifact_dir / "model.tar.gz"
        manifest_path = artifact_dir / "manifest.json"

        files = self._describe_files(result.result_dir)
        self._create_archive(result.result_dir, archive_path)
        metrics = self._read_metrics(result.result_dir)

        archive_key = spec.output_prefix + archive_path.name
        log_key = spec.output_prefix + "worker.log"
        manifest_key = spec.output_prefix + manifest_path.name
        selected: dict[str, str] = {}
        for item in files:
            relative = str(item["path"])
            source = result.result_dir / Path(*relative.split("/"))
            if source.suffix.lower() not in SELECTED_SUFFIXES:
                continue
            if source.stat().st_size > MAX_SELECTED_FILE_BYTES:
                continue
            key = spec.output_prefix + "files/" + relative
            self.storage.upload(source, key)
            selected[relative] = key

        manifest = {
            "schema_version": 1,
            "task_id": spec.task_id,
            "attempt": spec.attempt,
            "model": spec.model.name,
            "runtime": spec.runtime.key,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "elapsed_seconds": round(result.elapsed_seconds, 3),
            "archive": {
                "object_key": archive_key,
                "size_bytes": archive_path.stat().st_size,
                "sha256": sha256_file(archive_path),
            },
            "log_object_key": log_key if result.paths.log_file.is_file() else None,
            "selected_files": selected,
            "result_files": files,
            "metrics": metrics,
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )

        # Upload the archive first and the manifest last. The manifest is therefore the
        # commit marker for a completely published result bundle.
        self.storage.upload(archive_path, archive_key)
        if result.paths.log_file.is_file():
            self.storage.upload(result.paths.log_file, log_key)
        self.storage.upload(manifest_path, manifest_key)

        return ArtifactBundle(
            model_weights_path=archive_key,
            metrics=metrics,
            output_files={
                "archive": archive_key,
                "manifest": manifest_key,
                "log": log_key if result.paths.log_file.is_file() else None,
                "files": selected,
            },
        )

    @staticmethod
    def _create_archive(result_dir: Path, destination: Path) -> None:
        with tarfile.open(destination, "w:gz") as archive:
            archive.add(result_dir, arcname="result", recursive=True)

    @staticmethod
    def _describe_files(result_dir: Path) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for path in sorted(result_dir.rglob("*")):
            if not path.is_file():
                continue
            entries.append(
                {
                    "path": path.relative_to(result_dir).as_posix(),
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
        return entries

    @staticmethod
    def _read_metrics(result_dir: Path) -> dict[str, Any]:
        for path in sorted(result_dir.rglob("metrics.json")):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                return value
        return {}
