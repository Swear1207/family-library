#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?Missing repository}"
: "${GH_TOKEN:?Missing release token}"
: "${IMAGE_REPOSITORY:?Missing image repository}"
: "${SOURCE_REVISION:?Missing source revision}"
: "${SOURCE_DIGEST:?Missing image digest}"
: "${APP_VERSION:?Missing application version}"
: "${RUNNER_TEMP:?Missing runner temporary directory}"

[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid repository'; exit 1; }
[[ "$IMAGE_REPOSITORY" = "ghcr.io/${GITHUB_REPOSITORY,,}" ]] || { echo 'Image repository does not match source repository'; exit 1; }
[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo 'Source revision must be a full commit SHA'; exit 1; }
[[ "$SOURCE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid image digest'; exit 1; }
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid application version'; exit 1; }
expected_tag="v$APP_VERSION-${SOURCE_REVISION:0:7}"
RELEASE_TAG="${RELEASE_TAG:-$expected_tag}"
[[ "$RELEASE_TAG" = "$expected_tag" ]] || { echo 'Release tag does not match version and source revision'; exit 1; }
ARCHIVE_NAME="family-library-$APP_VERSION-linux-amd64.tar.gz"

release_target=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG" --jq '.target_commitish')
[[ "$release_target" = "$SOURCE_REVISION" ]] || { echo 'Existing release targets a different source revision'; exit 1; }

output_dir=$(mktemp -d "$RUNNER_TEMP/family-library-offline.XXXXXX")
source_image="$IMAGE_REPOSITORY@$SOURCE_DIGEST"
sha_tag="$IMAGE_REPOSITORY:sha-$SOURCE_REVISION"
latest_tag="$IMAGE_REPOSITORY:latest"
docker pull --platform linux/amd64 "$source_image"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$source_image")" = 'linux/amd64'
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$source_image")" = "$SOURCE_REVISION"
docker tag "$source_image" "$sha_tag"
docker tag "$source_image" "$latest_tag"
docker image inspect "$sha_tag" | jq -S '.[0] | {Architecture, Os, Config, RootFS}' > "$output_dir/image-config.json"
docker save --platform linux/amd64 "$sha_tag" "$latest_tag" | gzip -n -1 > "$output_dir/$ARCHIVE_NAME"
(
  cd "$output_dir"
  gzip --test "$ARCHIVE_NAME"
  sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
  sha256sum --check "$ARCHIVE_NAME.sha256"
)

# Containerd may replace a multi-platform index ID on load. Compare the actual
# platform, config and filesystem layers, while requiring both tags to agree.
docker image rm "$sha_tag" "$latest_tag"
docker load --input "$output_dir/$ARCHIVE_NAME"
test "$(docker image inspect --format '{{.Id}}' "$sha_tag")" = "$(docker image inspect --format '{{.Id}}' "$latest_tag")"
docker image inspect "$sha_tag" | jq -S '.[0] | {Architecture, Os, Config, RootFS}' > "$output_dir/restored-config.json"
cmp "$output_dir/image-config.json" "$output_dir/restored-config.json"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$sha_tag")" = "$SOURCE_REVISION"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$sha_tag")" = 'linux/amd64'

container_name="offline-check-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
volume_name="$container_name-data"
cleanup() {
  docker logs "$container_name" || true
  docker rm -f "$container_name" || true
  docker volume rm "$volume_name" || true
}
trap cleanup EXIT
docker run -d --pull never --platform linux/amd64 --name "$container_name" \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,source=$volume_name,target=/data" \
  -e APP_ORIGIN=http://127.0.0.1:18787 \
  -p 127.0.0.1:18787:8787 "$sha_tag"
healthy=false
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18787/healthz >/dev/null; then
    docker exec "$container_name" node -e "if(process.getuid()===0)process.exit(1);require('node:fs').accessSync('/data/setup-token.txt')"
    curl --fail --silent http://127.0.0.1:18787/reader.html >/dev/null
    curl --fail --silent http://127.0.0.1:18787/vendor/pdfjs/pdf.mjs >/dev/null
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" = true ]] || { echo 'Restored image did not become healthy'; exit 1; }

gh release upload "$RELEASE_TAG" "$output_dir/$ARCHIVE_NAME" "$output_dir/$ARCHIVE_NAME.sha256" \
  --repo "$GITHUB_REPOSITORY" --clobber
archive_url="https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/$ARCHIVE_NAME"
printf 'Offline image: %s\n' "$archive_url"
cat "$output_dir/$ARCHIVE_NAME.sha256"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n[Offline image](%s) · [SHA256](%s.sha256)\n\nSource: `%s` · manifest: `%s`\n\n' \
    "$archive_url" "$archive_url" "$SOURCE_REVISION" "$SOURCE_DIGEST" >> "$GITHUB_STEP_SUMMARY"
  cat "$output_dir/$ARCHIVE_NAME.sha256" >> "$GITHUB_STEP_SUMMARY"
fi
