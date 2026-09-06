(function(){
"use strict";
function init(options){
    const input=options.input;
    if(!input||!options.socket)return;
    const indicator=document.createElement("div");
    indicator.className="typing-indicator";
    const anchor=document.querySelector(".reply-preview")||document.querySelector(".input-area");
    anchor?.parentNode.insertBefore(indicator,anchor);
    const style=document.createElement("style");
    style.textContent='.typing-indicator{display:none;min-height:25px;padding:5px 15px;background:#fff;color:#64748b;font-size:12px;font-style:italic}.typing-indicator.show{display:block}@media(max-width:650px){.typing-indicator{min-height:21px;padding:4px 10px;font-size:10px}}';
    document.head.appendChild(style);
    let sent=false,stopTimer=null;
    const send=value=>{if(sent===value)return;sent=value;options.socket.emit(options.emitEvent,options.payload(value))};
    input.addEventListener("input",()=>{send(true);clearTimeout(stopTimer);stopTimer=setTimeout(()=>send(false),1100)});
    input.addEventListener("blur",()=>send(false));
    const active=new Map();
    options.socket.on(options.listenEvent,data=>{
        if(!options.accept(data))return;
        clearTimeout(active.get(data.userId)?.timer);
        if(data.typing){active.set(data.userId,{name:data.name,timer:setTimeout(()=>{active.delete(data.userId);render()},1800)})}else active.delete(data.userId);
        render();
    });
    function render(){const names=[...active.values()].map(value=>value.name);indicator.textContent=names.length?`${names.slice(0,2).join(", ")}${names.length>2?` 외 ${names.length-2}명`:""} 입력 중...`:"";indicator.classList.toggle("show",names.length>0)}
}
window.OurcomTyping={init};
})();
