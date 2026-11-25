# Base map drafts the weekly build made before $tag, as "id tag" lines.
# Input: the GitHub releases list. Used by tiles.yml to delete them.
.[]
| select(.draft)
| select(.tag_name | startswith("data-"))
| select(.tag_name != $tag)
| select((.body // "") | startswith("New base map"))
| select(any(.assets[]; .name == "guelph.pmtiles"))
| "\(.id) \(.tag_name)"
