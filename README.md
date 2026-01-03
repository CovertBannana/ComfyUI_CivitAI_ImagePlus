# ComfyUI CivitAI ImagePlus

**Browse CivitAI images in ComfyUI, preview protected images, and edit prompts before you generate.**

ComfyUI_CivitAI_ImagePlus adds a CivitAI gallery browser to ComfyUI, plus helper nodes for **protected image preview**, **prompt editing**, and **quick info**.

---

## ✅ What you can do

- **Open a full-screen CivitAI gallery** from inside ComfyUI
- **Pick an image** and instantly:
  - preview it (including **protected** images)
  - load its prompts into an editor
  - see a handy info panel
- **Fetch by URL** (paste a CivitAI link)
- Use the preview image for **img2img**

---

## 📸 Screenshots & demo workflows

Coming soon. (We’ll add screenshots and example workflows once they’re captured.)

Recommended demo files to add later:
- `workflows/demo_txt2img.json`
- `workflows/demo_img2img_protected.json`
- `workflows/demo_fetch_url.json`

---

## 🧩 Installation

### Option A — ComfyUI Manager
(Once this repo is public and indexed)
1. Open **ComfyUI → Manager**
2. Install **ComfyUI_CivitAI_ImagePlus**
3. Restart ComfyUI

### Option B — Manual
1. Go to your ComfyUI `custom_nodes` folder:
   - `ComfyUI/custom_nodes/`
2. Clone this repo:
   ```bash
   git clone https://github.com/<YOUR_USERNAME>/ComfyUI_CivitAI_ImagePlus.git
   ```
3. Restart ComfyUI

---

## 🔑 CivitAI API Key (required for protected images)

To preview and fetch **protected** content, you need a CivitAI API key.

1. Create this file:

```
custom_nodes/ComfyUI_CivitAI_ImagePlus/api_key.txt
```

2. Put your key inside like this:

```txt
CIVITAI_API_KEY=YOUR_CIVITAI_API_KEY_HERE
```

✅ Restart ComfyUI after adding/changing the key.

---

## 🧱 Nodes (what each one does)

### 1) **CivitAI Gallery (Rebuilt)**
Open the gallery and select images.

- **Open Gallery**: full-screen browsing
- **Fetch URL** + **Fetch**: paste a CivitAI URL and load the image

**Tip:** Using a **post URL** is best (example: `https://civitai.com/posts/<id>`).

---

### 2) **CivitAI Image Preview (Protected)**
Shows an instant preview (including protected images) and outputs an `IMAGE` for workflows.

- **Copy CivitAI Page URL** button: copies the CivitAI page link for the selected image (the page that shows generation info)
- Output: `IMAGE` (great for **img2img**)

---

### 3) **CivitAI Prompt Editor**
Lets you edit prompts before generating.

- Shows **Positive** + **Negative** previews right on the node
- Buttons at the bottom:
  - **Edit Positive** / **Edit Negative** (opens a big editor window)
  - **Restore** (revert to the original prompts from the last selection)
  - **Clear** (wipe prompts)

Output:
- Positive (STRING)
- Negative (STRING)

---

### 4) **CivitAI Info Display**
A small info preview panel that updates instantly when you select an image.

---

## 🔁 Recommended workflow setups

### A) txt2img (browse → edit → generate)
1. Select an image in **CivitAI Gallery**
2. Edit prompts in **CivitAI Prompt Editor**
3. Connect Prompt Editor outputs to your text/CLIP encode nodes
4. Generate

### B) img2img (protected preview → use as init image)
1. Select an image in **CivitAI Gallery**
2. Confirm it in **CivitAI Image Preview (Protected)**
3. Use Preview output as your **img2img init image**
4. Edit prompts in Prompt Editor

---

## 🛠 Troubleshooting

### Nothing updates instantly
- Restart ComfyUI
- Hard refresh your browser (Ctrl+F5)

### Protected images won’t preview
- Confirm `api_key.txt` exists and is formatted correctly:
  `CIVITAI_API_KEY=...`
- Restart ComfyUI

### Fetch says “No items returned”
- Prefer using a **post URL** (`/posts/<id>`)
- Some content may still be restricted by your CivitAI browsing/account settings

---

## 🔐 Security notes

- Your API key stays on your machine in `api_key.txt`.
- The browser does **not** need your key.

---

## 📄 License

MIT License (see `LICENSE`).
