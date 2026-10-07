#!/usr/bin/env python3
"""Copies one file out of a digest-pinned public container image, without a container daemon.

The Claude cloud VM cannot download GitHub release assets of repositories other than the one
attached to the session, so the Stripe CLI and Mailpit binaries are taken from their official
Docker Hub images instead. Google's Docker Hub mirror (mirror.gcr.io) is asked first, because
anonymous Docker Hub pulls are rate limited per IP and a cloud VM shares its egress address;
Docker Hub itself is the fallback. Both are on the cloud environment's default allowlist.

Which registry answered does not matter, because everything is content-addressed: the manifest
must hash to the pinned digest, every layer to the digest its manifest names, and the file itself
to the pinned checksum. A moved tag, a changed blob or a different file is refused, never installed.

Standard library only, because this runs before any project dependency exists.

Usage:
    fetch-image-file.py --image axllent/mailpit --digest sha256:... --path mailpit \\
        --sha256 <hex of the file itself> --dest /opt/x/mailpit
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REGISTRIES = ["https://mirror.gcr.io", "https://registry-1.docker.io"]
MANIFEST_TYPES = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


class FetchError(Exception):
    pass


class Registry:
    """A registry v2 endpoint with the standard anonymous bearer-token challenge."""

    def __init__(self, base: str, image: str) -> None:
        self.base = base
        self.image = image
        self.token: str | None = None

    def _open(self, url: str, accept: str | None):
        request = urllib.request.Request(url)
        if self.token:
            # Unredirected: blobs redirect to signed storage URLs that refuse a second auth scheme.
            request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        if accept:
            request.add_header("Accept", accept)
        return urllib.request.urlopen(request, timeout=300)

    def _authenticate(self, challenge: str) -> None:
        fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
        if "realm" not in fields:
            raise FetchError(f"{self.base} asked for authentication it did not describe")
        query = {key: value for key, value in fields.items() if key in ("service", "scope")}
        query.setdefault("scope", f"repository:{self.image}:pull")
        url = f"{fields['realm']}?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=60) as response:
            body = json.load(response)
        self.token = body.get("token") or body.get("access_token")
        if not self.token:
            raise FetchError(f"{self.base} issued no token")

    def get(self, path: str, accept: str | None = None):
        url = f"{self.base}/v2/{self.image}/{path}"
        try:
            return self._open(url, accept)
        except urllib.error.HTTPError as error:
            if error.code != 401 or self.token:
                raise
            self._authenticate(error.headers.get("WWW-Authenticate", ""))
            return self._open(url, accept)


def sha256_digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def fetch_manifest(registry: Registry, digest: str) -> dict:
    with registry.get(f"manifests/{digest}", MANIFEST_TYPES) as response:
        body = response.read()
    if sha256_digest(body) != digest:
        raise FetchError(f"manifest {digest} does not match its digest")
    return json.loads(body)


def platform_manifest(registry: Registry, digest: str, platform: str) -> dict:
    manifest = fetch_manifest(registry, digest)
    if "manifests" not in manifest:
        return manifest
    os_name, arch = platform.split("/", 1)
    for entry in manifest["manifests"]:
        entry_platform = entry.get("platform", {})
        if entry_platform.get("os") == os_name and entry_platform.get("architecture") == arch:
            return fetch_manifest(registry, entry["digest"])
    raise FetchError(f"{digest} has no {platform} manifest")


def download_blob(registry: Registry, digest: str, directory: str) -> str:
    target = os.path.join(directory, digest.replace(":", "_"))
    hasher = hashlib.sha256()
    with registry.get(f"blobs/{digest}") as response, open(target, "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            hasher.update(chunk)
            out.write(chunk)
    if "sha256:" + hasher.hexdigest() != digest:
        raise FetchError(f"layer {digest} does not match its digest")
    return target


def normalize(name: str) -> str:
    return name.lstrip("./").lstrip("/")


def extract(registry: Registry, args: argparse.Namespace) -> bytes:
    wanted = normalize(args.path)
    manifest = platform_manifest(registry, args.digest, args.platform)
    with tempfile.TemporaryDirectory() as directory:
        # The newest layer that contains the file wins, so search from the top of the stack down.
        for layer in reversed(manifest["layers"]):
            blob = download_blob(registry, layer["digest"], directory)
            with tarfile.open(blob, "r:*") as archive:
                for member in archive.getmembers():
                    if normalize(member.name) != wanted:
                        continue
                    if not member.isfile():
                        raise FetchError(f"{args.path} is not a regular file")
                    source = archive.extractfile(member)
                    if source is None:
                        raise FetchError(f"could not read {args.path}")
                    return source.read()
    raise FetchError(f"{args.path} is not in the image")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Docker Hub repository, e.g. axllent/mailpit")
    parser.add_argument("--digest", required=True, help="pinned index or manifest digest")
    parser.add_argument("--path", required=True, help="file inside the image, e.g. bin/stripe")
    parser.add_argument("--sha256", required=True, help="expected sha256 (hex) of the file itself")
    parser.add_argument("--dest", required=True, help="where to write it")
    parser.add_argument("--platform", default="linux/amd64")
    args = parser.parse_args()

    if not args.digest.startswith("sha256:"):
        sys.exit("fetch-image-file: --digest must be a sha256 digest; tags are never trusted")

    failures = []
    for base in REGISTRIES:
        try:
            content = extract(Registry(base, args.image), args)
        except (FetchError, OSError, ValueError, KeyError, tarfile.TarError) as error:
            failures.append(f"{base}: {error}")
            continue
        if hashlib.sha256(content).hexdigest() != args.sha256.lower():
            failures.append(f"{base}: {args.path} does not match the pinned sha256")
            continue
        os.makedirs(os.path.dirname(args.dest) or ".", exist_ok=True)
        partial = args.dest + ".partial"
        with open(partial, "wb") as out:
            out.write(content)
        os.chmod(partial, 0o755)
        os.replace(partial, args.dest)
        print(f"fetch-image-file: {args.image}@{args.digest} {args.path} -> {args.dest} ({base})")
        return
    sys.exit("fetch-image-file: " + "; ".join(failures))


if __name__ == "__main__":
    main()
