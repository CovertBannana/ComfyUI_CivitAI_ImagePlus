
from .civitai_gallery_backend import (
    CivitaiGalleryNode,
    CivitaiPromptEditorNode,
    CivitaiInfoDisplayNode,
    CivitaiImagePreviewNode,
)

NODE_CLASS_MAPPINGS = {
    "CivitaiGalleryNode": CivitaiGalleryNode,
    "CivitaiPromptEditorNode": CivitaiPromptEditorNode,
    "CivitaiInfoDisplayNode": CivitaiInfoDisplayNode,
    "CivitaiImagePreviewNode": CivitaiImagePreviewNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CivitaiGalleryNode": "CivitAI Gallery",
    "CivitaiPromptEditorNode": "CivitAI Prompt Editor",
    "CivitaiInfoDisplayNode": "CivitAI Info Display",
    "CivitaiImagePreviewNode": "CivitAI Image Preview",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
