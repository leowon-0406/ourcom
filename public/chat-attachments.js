(function () {
    "use strict";

    const limits = { image: 10 * 1024 * 1024, video: 40 * 1024 * 1024, raw: 10 * 1024 * 1024 };
    let selectedFile = null;
    let fileInput = null;
    let status = null;
    let sendButton = null;

    const style = document.createElement("style");
    style.textContent = `
        .attach-button { flex: 0 0 auto; width: 42px; margin-right: 8px; border: 1px solid #d1d5db; border-radius: 12px; background: #fff; cursor: pointer; font-size: 20px; }
        .file-status { display: none; gap: 8px; align-items: center; padding: 9px 15px; border-top: 1px solid #e5e7eb; background: #f8fafc; color: #475569; font-size: 13px; }
        .file-status.show { display: flex; }
        .file-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
        .file-cancel { border: 0; background: transparent; cursor: pointer; font-size: 20px; }
        .attachment { display: block; margin-top: 7px; }
        .attachment-image { display: block; max-width: min(280px, 100%); max-height: 320px; border-radius: 10px; cursor: pointer; object-fit: cover; }
        .attachment-video { display: block; width: min(320px, 100%); max-height: 360px; border-radius: 10px; background: #000; }
        .attachment-file { display: flex; gap: 8px; align-items: center; padding: 10px; border-radius: 9px; background: rgba(148,163,184,.18); color: inherit; text-decoration: none; }
        .attachment-size { opacity: .7; font-size: 11px; }
        .message-actions { display: inline-flex; align-items: center; }
        @media (max-width: 700px), (pointer: coarse) {
            .message-actions { display: none; margin-top: 6px; }
            .message.actions-open .message-actions { display: inline-flex; }
            .message.actions-open .bubble { outline: 2px solid #a5b4fc; }
        }
    `;
    document.head.appendChild(style);

    function resourceType(file) {
        if (/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return "image";
        if (/^video\/(mp4|webm)$/.test(file.type)) return "video";
        if (file.type === "application/pdf") return "raw";
        return null;
    }

    function formatBytes(bytes) {
        if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    }

    function chooseFile(file) {
        const type = resourceType(file);
        if (!type) {
            alert("JPG·PNG·WEBP·GIF 사진, MP4·WEBM 동영상, PDF만 보낼 수 있습니다.");
            fileInput.value = "";
            return;
        }
        if (file.size > limits[type]) {
            alert(type === "video" ? "동영상은 40MB 이하만 보낼 수 있습니다." : "사진과 PDF는 10MB 이하만 보낼 수 있습니다.");
            fileInput.value = "";
            return;
        }
        selectedFile = file;
        status.classList.add("show");
        status.querySelector(".file-status-text").textContent = `📎 ${file.name} · ${formatBytes(file.size)}`;
    }

    function clear() {
        selectedFile = null;
        if (fileInput) fileInput.value = "";
        if (status) {
            status.classList.remove("show");
            status.querySelector(".file-status-text").textContent = "";
        }
    }

    function init() {
        const area = document.querySelector(".input-area");
        sendButton = document.getElementById("sendButton");
        if (!area || document.getElementById("attachmentInput")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attach-button";
        button.textContent = "+";
        button.title = "사진·동영상·PDF 첨부";
        button.setAttribute("aria-label", "파일 첨부");
        fileInput = document.createElement("input");
        fileInput.id = "attachmentInput";
        fileInput.type = "file";
        fileInput.accept = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,application/pdf";
        fileInput.hidden = true;
        button.onclick = () => fileInput.click();
        fileInput.onchange = () => fileInput.files[0] && chooseFile(fileInput.files[0]);
        area.prepend(fileInput);
        area.prepend(button);

        status = document.createElement("div");
        status.className = "file-status";
        status.innerHTML = '<span class="file-status-text"></span><button type="button" class="file-cancel" aria-label="첨부 취소">×</button>';
        status.querySelector("button").onclick = clear;
        area.parentNode.insertBefore(status, area);
    }

    async function uploadSelected() {
        if (!selectedFile) return null;
        const file = selectedFile;
        const type = resourceType(file);
        const signatureResponse = await fetch("/api/cloudinary-signature", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resourceType: type })
        });
        const signature = await signatureResponse.json();
        if (!signatureResponse.ok || !signature.success) throw new Error(signature.message || "파일 업로드를 준비하지 못했습니다.");

        const form = new FormData();
        form.append("file", file);
        form.append("api_key", signature.apiKey);
        form.append("timestamp", signature.timestamp);
        form.append("folder", signature.folder);
        form.append("signature", signature.signature);

        const uploaded = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/${type}/upload`);
            xhr.upload.onprogress = event => {
                if (!event.lengthComputable) return;
                const percent = Math.round(event.loaded / event.total * 100);
                status.querySelector(".file-status-text").textContent = `업로드 중… ${percent}% · ${file.name}`;
            };
            xhr.onload = () => {
                let data;
                try { data = JSON.parse(xhr.responseText); } catch { data = null; }
                if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
                else reject(new Error(data?.error?.message || "파일 업로드에 실패했습니다."));
            };
            xhr.onerror = () => reject(new Error("파일 업로드 중 네트워크 오류가 발생했습니다."));
            xhr.send(form);
        });

        clear();
        return {
            resourceType: type,
            publicId: uploaded.public_id,
            secureUrl: uploaded.secure_url,
            fileName: file.name,
            mimeType: file.type,
            bytes: uploaded.bytes
        };
    }

    function appendToBubble(bubble, attachment, deleted) {
        if (!attachment || deleted) return;
        const holder = document.createElement("span");
        holder.className = "attachment";
        if (attachment.resourceType === "image") {
            const image = document.createElement("img");
            image.className = "attachment-image";
            image.src = attachment.secureUrl;
            image.alt = attachment.fileName || "첨부 이미지";
            image.loading = "lazy";
            image.onclick = () => window.open(attachment.secureUrl, "_blank", "noopener");
            holder.appendChild(image);
        } else if (attachment.resourceType === "video") {
            const video = document.createElement("video");
            video.className = "attachment-video";
            video.src = attachment.secureUrl;
            video.controls = true;
            video.preload = "metadata";
            holder.appendChild(video);
        } else {
            const link = document.createElement("a");
            link.className = "attachment-file";
            link.href = attachment.secureUrl;
            link.target = "_blank";
            link.rel = "noopener";
            link.innerHTML = `<span>📄</span><span>${escapeHtml(attachment.fileName || "PDF 파일")}<br><small class="attachment-size">${formatBytes(Number(attachment.bytes) || 0)}</small></span>`;
            holder.appendChild(link);
        }
        bubble.appendChild(holder);
    }

    function escapeHtml(value) {
        const span = document.createElement("span");
        span.textContent = value;
        return span.innerHTML;
    }

    function preview(message) {
        return message.text || (message.attachment ? `📎 ${message.attachment.fileName || "파일"}` : "메시지");
    }

    let closeListenerAdded = false;
    function enableLongPress(element) {
        let timer = null;
        let startX = 0;
        let startY = 0;
        const mobile = () => matchMedia("(max-width: 700px), (pointer: coarse)").matches;
        const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
        element.addEventListener("pointerdown", event => {
            if (!mobile() || event.target.closest("button,a,video")) return;
            startX = event.clientX;
            startY = event.clientY;
            timer = setTimeout(() => {
                document.querySelectorAll(".message.actions-open").forEach(item => item.classList.remove("actions-open"));
                element.classList.add("actions-open");
                navigator.vibrate?.(30);
                timer = null;
            }, 550);
        });
        element.addEventListener("pointermove", event => {
            if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancel();
        });
        element.addEventListener("pointerup", cancel);
        element.addEventListener("pointercancel", cancel);
        element.addEventListener("contextmenu", event => {
            if (mobile() && !event.target.closest("button,a,video")) event.preventDefault();
        });
        if (!closeListenerAdded) {
            document.addEventListener("pointerdown", event => {
                document.querySelectorAll(".message.actions-open").forEach(item => {
                    if (!item.contains(event.target)) item.classList.remove("actions-open");
                });
            });
            closeListenerAdded = true;
        }
    }

    window.OurcomFiles = {
        init,
        hasFile: () => Boolean(selectedFile),
        uploadSelected,
        clear,
        appendToBubble,
        preview,
        enableLongPress,
        setSending(value) {
            if (sendButton) {
                sendButton.disabled = value;
                sendButton.textContent = value ? "업로드 중…" : "전송";
            }
        }
    };
})();
