# ComfyUI CivitAI ImagePlus

**Browse CivitAI images in ComfyUI, preview protected images, edit prompts before generating, and pass selected images into img2img workflows.**

**Tested on current stable ComfyUI releases (verified on 0.19.x at time of writing).**

ComfyUI_CivitAI_ImagePlus adds a CivitAI gallery browser to ComfyUI, plus helper nodes for:

- **image preview with img2img connector**
- **prompt editing**
- **quick info display**

Nodes are populated instantly without needing to run the workflow first.

---

## ✅ What you can do

- **Open a full-screen CivitAI gallery** from inside ComfyUI
- Browse images using:
  - **Most Reactions**
  - **Most Comments**
  - **Newest**
- **Pick an image** and instantly:
  - preview it
  - preview **protected** images if you have a valid CivitAI API key
  - load its prompts into an editor
  - see a handy info panel
- **Fetch by URL** using a CivitAI page link
- Use the selected preview image as input for **img2img** workflows

---

## 🌐 CivitAI domain compatibility

CivitAI now uses separate public-facing domains:

- `https://civitai.com`
- `https://civitai.red`

This plugin supports both for:

- **Fetch URL** input
- copied page links
- protected preview routing

The gallery includes a **Page Links** selector so you can choose:

- **Auto**
- **Civitai.com**
- **Civitai.red**

If you paste a CivitAI URL directly, the plugin will try to preserve that domain automatically.

---

## 📸 Demo workflows

Example workflows:

- [workflows/Gallery_text_to_image.json](https://github.com/CovertBannana/ComfyUI_CivitAI_ImagePlus/blob/main/workflows/Gallery_text_to_image.json)
- [workflows/Gallery_image_to_image.json](https://github.com/CovertBannana/ComfyUI_CivitAI_ImagePlus/blob/main/workflows/Gallery_image_to_image.json)
- [workflows/Gallery_Z-image_Turbo.json](https://github.com/CovertBannana/ComfyUI_CivitAI_ImagePlus/blob/main/workflows/Gallery_Z-image_Turbo.json)

**Note:**

- The text-to-image and image-to-image workflows use ComfyUI core nodes plus this node pack.
- The Z-image Turbo workflow uses additional custom nodes.

---

## 🧩 Installation

### Option A — ComfyUI Manager / Registry

1. Open **ComfyUI → Manager**
2. Search for **CivitAI ImagePlus**
3. Install the node pack
4. Restart ComfyUI

### Option B — Manual

1. Go to your ComfyUI `custom_nodes` folder:
   - `ComfyUI/custom_nodes/`
2. Clone this repo:

```bash
git clone https://github.com/CovertBannana/ComfyUI_CivitAI_ImagePlus.git
```

3. Restart ComfyUI

### Option C — ZIP

1. If you are having trouble with Git, click the **Code** button on GitHub and download the repository as a ZIP
2. Extract the folder into your ComfyUI `custom_nodes` directory
3. Restart ComfyUI

---

## 🔑 CivitAI API Key (required for protected images)

To preview and fetch **protected** content, you need a CivitAI API key.

1. Create the file if it does not exist:

```txt
custom_nodes/ComfyUI_CivitAI_ImagePlus/api_key.txt
```

2. Put your key inside like this:

```txt
CIVITAI_API_KEY=YOUR_CIVITAI_API_KEY_HERE
```

✅ Restart ComfyUI after adding or changing the key.

### Security note

Protected image previews are handled **server-side**.

- Your API key stays on your machine in `api_key.txt`
- The browser UI does **not** need direct access to your key

---

## 🧱 Nodes

### 1) **CivitAI Gallery**

Open the gallery and select images.

- **Open Gallery** → full-screen browsing
- **Fetch URL** + **Fetch** → paste a CivitAI URL and load the image

**Tip:** you can use either:

- a **post URL** like `https://civitai.com/posts/<id>` or `https://civitai.red/posts/<id>`
- an **image URL** like `https://civitai.com/images/<id>` or `https://civitai.red/images/<id>`

---

### 2) **CivitAI Image Preview**

- Shows the selected preview image directly in the node
- Includes **Copy CivitAI Page URL** button
- Output: `IMAGE`

This makes it ideal for **img2img** workflows.

---

### 3) **CivitAI Prompt Editor**

Lets you edit prompts before generating.

- Shows **Positive** and **Negative** previews directly on the node
- Bottom buttons:
  - **Edit Positive**
  - **Edit Negative**
  - **Restore** → revert to prompts from the last selection
  - **Clear** → wipe both prompts

Outputs:

- `Positive` (`STRING`)
- `Negative` (`STRING`)

---

### 4) **CivitAI Info Display**

A small info preview panel that updates instantly when you select an image.

---

## 🔁 Recommended workflow setups

### A) txt2img (browse → edit → generate)

1. Select an image in **CivitAI Gallery**
2. Edit prompts in **CivitAI Prompt Editor**
3. Connect Prompt Editor outputs to your text / CLIP encode nodes
4. Generate

### B) img2img (preview → use as init image)

1. Select an image in **CivitAI Gallery**
2. Confirm it in **CivitAI Image Preview**
3. Use Preview output as your **img2img init image**
4. Edit prompts in Prompt Editor

---

## 🛠 Troubleshooting

### Nothing updates instantly

- Restart ComfyUI
- Hard refresh your browser (`Ctrl+F5`)

### Protected images will not preview

- Confirm `api_key.txt` exists and is formatted correctly:

```txt
CIVITAI_API_KEY=...
```

- Restart ComfyUI

### Fetch says “No items returned”

- Prefer using a **post URL** (`/posts/<id>`) when possible
- Some content may still be restricted by CivitAI account, domain, or region visibility rules

### Page links open on the wrong domain

Use the gallery’s **Page Links** selector:

- **Auto**
- **Civitai.com**
- **Civitai.red**

If you fetch by URL, the plugin will try to preserve that domain automatically.

---

## 🧪 Compatibility notes

- Tested on current stable ComfyUI builds
- Uses standard ComfyUI frontend extension registration
- If you are testing against nightly/master builds, upstream frontend changes may land before a stable release

---

## 📄 License

MIT License (see `LICENSE`).

---

## 🙏 Acknowledgements

Inspired by earlier community work exploring similar workflows and UI ideas.
