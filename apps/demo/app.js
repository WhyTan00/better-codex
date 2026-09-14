const state = {
  workspace: "ai",
  cacheVersion: 42,
  cacheCount: 18,
  pending: 0,
};

const $ = (selector) => document.querySelector(selector);
const messageList = $("#message-list");
const scroll = $("#conversation-scroll");

function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2400);
}

function updateCache() {
  state.cacheVersion += 1;
  state.cacheCount += 1;
  $("#cache-count").textContent = state.cacheCount;
  $("#cache-time").textContent = "updated just now";
  $("#cache-progress").style.width = `${Math.min(94, 74 + state.pending * 4)}%`;
  $(".version-tag").textContent = `v${state.cacheVersion}`;
}

function addMessage(text) {
  const item = document.createElement("article");
  item.className = "message user-message pending-message";
  item.innerHTML = `<div class="avatar user-avatar">Z</div><div class="message-body"><div class="message-meta"><b>You</b><time>now</time></div><p></p><div class="message-note"><span>◌</span> Painting locally · waiting for Harness acknowledgement</div></div>`;
  item.querySelector("p").textContent = text;
  messageList.append(item);
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  return item;
}

$("#workspace").addEventListener("change", (event) => {
  state.workspace = event.target.value;
  toast(state.workspace === "ai" ? "Switched to AI workspace" : "Switched to Creative workspace");
});

document.querySelectorAll(".thread").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".thread").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $("#conversation-name").textContent = button.querySelector("b").textContent;
    toast("Mounted cached conversation projection");
  });
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    toast(`${button.textContent.trim()} view selected`);
  });
});

$("#refresh").addEventListener("click", () => {
  $("#connection-pill").innerHTML = '<span class="pulse"></span> Reconnecting';
  setTimeout(() => {
    $("#connection-pill").innerHTML = '<span class="pulse"></span> Harness connected';
    updateCache();
    toast("Reconciled with the native event stream");
  }, 650);
});

$("#attach").addEventListener("click", () => toast("Document link ready — provider adapter owns the upload"));
$("#show-cache").addEventListener("click", () => toast(`Cache v${state.cacheVersion}: ${state.cacheCount} bounded projections warm`));
$("#close-inspector").addEventListener("click", () => toast("The status panel stays available in the workbench shell"));

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    toast("Write a prompt first");
    return;
  }
  $("#prompt").value = "";
  state.pending += 1;
  $("#composer-state").textContent = "Painting locally…";
  const message = addMessage(prompt);
  const note = message.querySelector(".message-note");
  setTimeout(() => {
    note.innerHTML = "<span>✓</span> Accepted by native Harness · syncing";
    updateCache();
  }, 750);
  setTimeout(() => {
    note.innerHTML = "<span>✓</span> Confirmed in canonical conversation";
    state.pending = Math.max(0, state.pending - 1);
    $("#composer-state").textContent = state.pending ? "Another send is syncing" : "Ready to send";
    updateCache();
  }, 1450);
});

$("#prompt").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    $("#composer").requestSubmit();
  }
});
