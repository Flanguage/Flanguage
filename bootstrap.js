(() => {
  "use strict";

  const fresh = Date.now().toString(36);

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.async = true;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error(`Could not load ${source}.`)),
        { once: true },
      );
      document.body.append(script);
    });
  }

  async function start() {
    await loadScript(`data/catalog.js?fresh=${fresh}`);
    const catalogRevision = encodeURIComponent(
      window.FLANGUAGE_CATALOG?.generatedAt || fresh,
    );
    await Promise.all([
      loadScript(
        `data/fingerprints.js?catalog=${catalogRevision}&fresh=${fresh}`,
      ),
      loadScript(
        `data/spectrum-index.js?catalog=${catalogRevision}&fresh=${fresh}`,
      ),
    ]);
    await loadScript("winamp-mode.js?v=1");
    await loadScript(`app.js?v=13&catalog=${catalogRevision}`);
  }

  start().catch(() => {
    const message = document.createElement("p");
    message.className = "noscript";
    message.append("LOAD ERROR. ");
    const link = document.createElement("a");
    link.href = "https://flanguage.bandcamp.com";
    link.textContent = "OPEN BANDCAMP.";
    message.append(link);
    document.body.append(message);
  });
})();
