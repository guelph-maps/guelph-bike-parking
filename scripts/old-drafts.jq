# Base map drafts the weekly build made before $tag, as "id tag" lines.
# Input: the GitHub releases list. Used by tiles.yml to delete them.
.[]
| select(.draft)
| select(.tag_name | startswith("data-"))
| select(.tag_name != $tag)
| select((.body // "") | startswith("New base map"))
# guelph.pmtiles, or guelph.v2.pmtiles and up after a map format bump (scripts/formats.mjs)
| select(any(.assets[]; .name | test("^guelph(\\.v[0-9]+)?\\.pmtiles$")))
| "\(.id) \(.tag_name)"
