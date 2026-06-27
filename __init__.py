
from .civitai_gallery_backend import (
    CivitaiGalleryNode,
    CivitaiPromptEditorNode,
    CivitaiInfoDisplayNode,
    CivitaiImagePreviewNode,
    LocalImageInfoNode,
)

NODE_CLASS_MAPPINGS = {
    "CivitaiGalleryNode": CivitaiGalleryNode,
    "CivitaiPromptEditorNode": CivitaiPromptEditorNode,
    "CivitaiInfoDisplayNode": CivitaiInfoDisplayNode,
    "CivitaiImagePreviewNode": CivitaiImagePreviewNode,
    "LocalImageInfoNode": LocalImageInfoNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CivitaiGalleryNode": "CivitAI Gallery",
    "CivitaiPromptEditorNode": "CivitAI Prompt Editor",
    "CivitaiInfoDisplayNode": "CivitAI Info Display",
    "CivitaiImagePreviewNode": "CivitAI Image Preview",
    "LocalImageInfoNode": "CivitAI Local Image Info",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
