(function () {
  var blocked = {
    "gmail.com": 1,
    "googlemail.com": 1,
    "yahoo.com": 1,
    "yahoo.co.uk": 1,
    "ymail.com": 1,
    "rocketmail.com": 1,
    "hotmail.com": 1,
    "hotmail.co.uk": 1,
    "outlook.com": 1,
    "live.com": 1,
    "msn.com": 1,
    "icloud.com": 1,
    "me.com": 1,
    "mac.com": 1,
    "aol.com": 1
  };
  document.querySelectorAll("form[data-work-email]").forEach(function (form) {
    var input = form.querySelector('input[name="email"]');
    var note = form.querySelector("[data-email-error]");
    if (!input) return;
    form.addEventListener("submit", function (event) {
      var email = (input.value || "").trim().toLowerCase();
      var domain = email.split("@")[1] || "";
      var ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !blocked[domain];
      if (ok) return;
      event.preventDefault();
      if (note) note.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    });
  });
})();
