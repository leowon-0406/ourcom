(function () {
    "use strict";
    let options = null;

    const style = document.createElement("style");
    style.textContent = `
        .chat-search-button { flex:0 0 auto; min-height:38px; margin-left:8px; padding:8px 12px; border:0; border-radius:10px; background:#4b5563; color:#fff; font-weight:bold; cursor:pointer; }
        .chat-search-modal { display:none; position:fixed; inset:0; z-index:1200; padding:20px; background:rgba(0,0,0,.45); align-items:center; justify-content:center; }
        .chat-search-modal.open { display:flex; }
        .chat-search-box { width:min(560px,100%); max-height:min(680px,90vh); display:flex; flex-direction:column; padding:20px; border-radius:18px; background:#fff; color:#111827; }
        .chat-search-title { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .chat-search-title h3 { margin:0; }
        .chat-search-close { border:0; background:transparent; font-size:24px; cursor:pointer; }
        .chat-search-form { display:flex; gap:8px; margin:15px 0; }
        .chat-search-input { min-width:0; flex:1; padding:11px; border:1px solid #d1d5db; border-radius:10px; font-size:16px; }
        .chat-search-submit { padding:10px 15px; border:0; border-radius:10px; background:#111827; color:#fff; font-weight:bold; cursor:pointer; }
        .chat-search-results { overflow:auto; }
        .chat-search-result { width:100%; padding:12px 8px; border:0; border-bottom:1px solid #e5e7eb; background:#fff; text-align:left; cursor:pointer; }
        .chat-search-result:hover { background:#f8fafc; }
        .chat-search-meta { margin-bottom:5px; color:#6b7280; font-size:12px; }
        .chat-search-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
        .unread-divider { display:flex; align-items:center; gap:10px; margin:12px 0; color:#ef4444; font-size:12px; font-weight:bold; }
        .unread-divider::before,.unread-divider::after { content:""; flex:1; height:1px; background:#fca5a5; }
        @media (max-width:650px) { .chat-search-button { width:40px; padding:8px; font-size:0; } .chat-search-button::before { content:"검색"; font-size:11px; } }
    `;
    document.head.appendChild(style);

    function buildUI() {
        if (document.getElementById("chatSearchModal")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-search-button";
        button.textContent = "검색";
        button.onclick = open;
        document.querySelector(".header")?.appendChild(button);

        const modal = document.createElement("div");
        modal.id = "chatSearchModal";
        modal.className = "chat-search-modal";
        modal.innerHTML = `
            <div class="chat-search-box" role="dialog" aria-modal="true" aria-label="메시지 검색">
                <div class="chat-search-title"><h3>메시지 검색</h3><button class="chat-search-close" type="button" aria-label="닫기">×</button></div>
                <form class="chat-search-form"><input class="chat-search-input" maxlength="100" placeholder="검색할 내용을 입력하세요"><button class="chat-search-submit" type="submit">검색</button></form>
                <div class="chat-search-results">검색어를 입력해주세요.</div>
            </div>`;
        modal.onclick = event => { if (event.target === modal) close(); };
        modal.querySelector(".chat-search-close").onclick = close;
        modal.querySelector("form").onsubmit = event => { event.preventDefault(); search(); };
        document.body.appendChild(modal);
    }

    function open() {
        const modal = document.getElementById("chatSearchModal");
        modal.classList.add("open");
        modal.querySelector("input").focus();
    }

    function close() {
        document.getElementById("chatSearchModal")?.classList.remove("open");
    }

    async function search() {
        const modal = document.getElementById("chatSearchModal");
        const term = modal.querySelector("input").value.trim();
        const results = modal.querySelector(".chat-search-results");
        if (!term) { results.textContent = "검색어를 입력해주세요."; return; }
        results.textContent = "검색 중...";
        try {
            const response = await fetch(`${options.endpoint}?q=${encodeURIComponent(term)}`);
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || "검색에 실패했습니다.");
            results.innerHTML = "";
            if (!data.messages.length) { results.textContent = "검색 결과가 없습니다."; return; }
            data.messages.forEach(message => {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "chat-search-result";
                const meta = document.createElement("div");
                meta.className = "chat-search-meta";
                meta.textContent = `${message.senderName} · ${message.time}`;
                const text = document.createElement("div");
                text.className = "chat-search-text";
                text.textContent = message.text || (message.attachment ? `[파일] ${message.attachment.fileName || "파일"}` : "메시지");
                item.append(meta, text);
                item.onclick = async () => {
                    close();
                    const found = await options.ensureMessageVisible(message.id);
                    if (!found) return alert("메시지를 불러오지 못했습니다.");
                    options.scrollToMessage(message.id);
                };
                results.appendChild(item);
            });
        } catch (error) {
            results.textContent = error.message || "검색 중 오류가 발생했습니다.";
        }
    }

    async function showUnreadMarker(messageId) {
        const id = Number(messageId);
        if (!Number.isInteger(id)) return;
        const found = await options.ensureMessageVisible(id);
        if (!found) return;
        document.querySelector(".unread-divider")?.remove();
        const target = document.querySelector(`[data-message-id="${id}"]`);
        if (!target) return;
        const divider = document.createElement("div");
        divider.className = "unread-divider";
        divider.textContent = "여기부터 안 읽은 메시지";
        target.parentNode.insertBefore(divider, target);
        requestAnimationFrame(() => divider.scrollIntoView({ behavior: "smooth", block: "center" }));
    }

    function init(value) {
        options = value;
        buildUI();
    }

    window.OurcomChatTools = { init, showUnreadMarker };
})();
