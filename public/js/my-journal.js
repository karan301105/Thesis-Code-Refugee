(async function () {
  const privateList = document.getElementById("privateList");
  const publicList = document.getElementById("publicList");
  const privTxt = document.getElementById("privContainerTxt");
  const pubTxt = document.getElementById("pubContainerTxt");
  const refreshBtn = document.getElementById("refreshBtn");

  function renderEntries(el, data) {
    if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
      el.className = "empty";
      el.innerHTML = "No entries found.";
      return;
    }
    el.className = "";
    const frag = document.createDocumentFragment();
    data.entries.forEach((e) => {
      const div = document.createElement("div");
      div.className = "entry";
      div.innerHTML = `
        <div>
          <div><strong>${e.id}</strong></div>
          <div class="muted">date: ${e.date_hint || "—"}</div>
          <div class="muted"><code>${e.url}</code></div>
        </div>
        <div class="row">
          <button class="btn danger" data-url="${e.url}">Delete</button>
        </div>
      `;
      frag.appendChild(div);
    });
    el.innerHTML = "";
    el.appendChild(frag);

    // inside renderEntries(el, data) ... after we inject the list HTML
    el.querySelectorAll("button.btn.danger").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const url = btn.getAttribute("data-url");
        if (
          !confirm(
            "Delete this entry from your Solid Pod? This cannot be undone.",
          )
        )
          return;

        btn.disabled = true;
        btn.textContent = "Deleting…";

        // ⬇️ call the server to delete (private or public) by Solid URL
        const r = await fetch("/journal/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });

        if (!r.ok) {
          alert("Failed to delete the entry.");
          btn.disabled = false;
          btn.textContent = "Delete";
          return;
        }

        // Refresh both sections after deletion
        await load();
      });
    });
  }

  async function load() {
    privateList.innerHTML = "Loading…";
    publicList.innerHTML = "Loading…";
    try {
      const res = await fetch("/journal/mine");
      if (!res.ok) {
        const msg = `Error: ${res.status} ${res.statusText}`;
        privateList.innerHTML = msg;
        publicList.innerHTML = msg;
        return;
      }
      const data = await res.json();
      privTxt.textContent = data?.private?.containerUrl || "";
      pubTxt.textContent = data?.public?.containerUrl || "";
      renderEntries(privateList, data.private);
      renderEntries(publicList, data.public);
    } catch (e) {
      privateList.innerHTML = "Failed to load.";
      publicList.innerHTML = "Failed to load.";
    }
  }

  refreshBtn.addEventListener("click", load);
  load();
})();
