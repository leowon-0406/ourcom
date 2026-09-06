(function () {
    "use strict";
    let registrationPromise = null;
    let installPrompt = null;

    const refreshStyle = document.createElement("style");
    refreshStyle.textContent = `
        .ourcom-refresh-button {
            flex: 0 0 auto;
            min-height: 38px;
            margin-left: 8px;
            padding: 8px 12px;
            border: 0;
            border-radius: 10px;
            background: #4b5563;
            color: white;
            font-weight: bold;
            cursor: pointer;
        }
        .ourcom-refresh-button:hover { background: #6b7280; }
        .ourcom-refresh-button:disabled { opacity: .6; cursor: wait; }
        .ourcom-refresh-button.floating { position: fixed; top: 14px; right: 14px; z-index: 1000; }
        @media (max-width: 650px) {
            .ourcom-refresh-button { width: 40px; padding: 8px; font-size: 18px; }
            .ourcom-refresh-label { display: none; }
        }
    `;
    document.head.appendChild(refreshStyle);

    function register() {
        if (!("serviceWorker" in navigator)) return Promise.resolve(null);
        if (!registrationPromise) {
            registrationPromise = navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
                .then(() => navigator.serviceWorker.ready)
                .catch(error => {
                    console.error("서비스 워커 등록 오류:", error);
                    return null;
                });
        }
        return registrationPromise;
    }

    function base64ToBytes(value) {
        const padding = "=".repeat((4 - value.length % 4) % 4);
        const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
        return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    }

    function updateButtons() {
        const installButton = document.getElementById("installAppButton");
        if (installButton) {
            const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
            installButton.style.display = installed ? "none" : "inline-flex";
            installButton.disabled = false;
            installButton.textContent = installPrompt ? "📲 앱 설치" : "브라우저 메뉴에서 앱 설치";
        }
        updatePushButton();
    }

    async function updatePushButton() {
        const button = document.getElementById("enablePushButton");
        const status = document.getElementById("pushStatus");
        if (!button) return;
        if (!("Notification" in window) || !("PushManager" in window)) {
            button.disabled = true;
            button.textContent = "알림 미지원";
            if (status) status.textContent = "이 브라우저에서는 푸시 알림을 지원하지 않습니다.";
            return;
        }
        const registration = await register();
        const subscription = await registration?.pushManager.getSubscription();
        button.disabled = false;
        button.textContent = subscription ? "🔔 알림 사용 중" : "🔕 푸시 알림 켜기";
        if (status) status.textContent = subscription
            ? "앱을 닫아도 새 메시지 알림을 받을 수 있습니다."
            : "버튼을 눌러 새 메시지 알림을 허용하세요.";
    }

    async function enablePush() {
        if (!("Notification" in window) || !("PushManager" in window)) {
            alert("이 브라우저에서는 푸시 알림을 사용할 수 없습니다.");
            return false;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            alert("알림 권한이 허용되지 않았습니다. 브라우저 사이트 설정에서 알림을 허용해주세요.");
            await updatePushButton();
            return false;
        }
        const registration = await register();
        if (!registration) throw new Error("서비스 워커를 준비하지 못했습니다.");
        const keyResponse = await fetch("/api/push/public-key");
        const keyData = await keyResponse.json();
        if (!keyResponse.ok || !keyData.success) throw new Error(keyData.message || "알림 키를 불러오지 못했습니다.");
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64ToBytes(keyData.publicKey)
            });
        }
        const response = await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription: subscription.toJSON() })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "알림 등록에 실패했습니다.");
        await updatePushButton();
        return true;
    }

    async function unsubscribePush() {
        const registration = await register();
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        try {
            await fetch("/api/push/subscribe", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
        } finally {
            await subscription.unsubscribe();
        }
    }

    async function syncExistingPush() {
        const registration = await register();
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        try {
            await fetch("/api/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription: subscription.toJSON() })
            });
        } catch (error) {
            console.error("푸시 구독 동기화 오류:", error);
        }
    }

    async function installApp() {
        if (!installPrompt) {
            alert("브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택해주세요.");
            return;
        }
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        updateButtons();
    }

    async function refreshApp(button) {
        if (button) {
            button.disabled = true;
            button.querySelector(".ourcom-refresh-label")?.replaceChildren("확인 중");
        }
        try {
            const registration = await navigator.serviceWorker?.getRegistration();
            await registration?.update();
        } catch (error) {
            console.error("앱 업데이트 확인 오류:", error);
        }
        location.reload();
    }

    function addRefreshButton() {
        if (document.querySelector(".ourcom-refresh-button")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ourcom-refresh-button";
        button.title = "최신 내용으로 새로고침";
        button.setAttribute("aria-label", "최신 내용으로 새로고침");
        button.innerHTML = '↻ <span class="ourcom-refresh-label">새로고침</span>';
        button.onclick = () => refreshApp(button);
        const header = document.querySelector(".header");
        if (header) header.appendChild(button);
        else {
            button.classList.add("floating");
            document.body.appendChild(button);
        }
    }

    window.addEventListener("beforeinstallprompt", event => {
        event.preventDefault();
        installPrompt = event;
        updateButtons();
    });
    window.addEventListener("appinstalled", () => {
        installPrompt = null;
        updateButtons();
    });
    window.addEventListener("DOMContentLoaded", () => {
        addRefreshButton();
        updateButtons();
        syncExistingPush();
    });
    register();

    window.OurcomPWA = { installApp, enablePush, unsubscribePush, updateButtons, refreshApp };
})();
