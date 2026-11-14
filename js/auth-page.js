(function () {
  const { toast, escapeHtml, showLoading } = window.Utils;
  const view = document.getElementById("auth-view");

  const signInHTML = `
    <h2>Sign in</h2>
    <p class="sub">Access the factory management system</p>
    <form id="signin-form">
      <div class="form-group">
        <label>Email</label>
        <input class="input" type="email" name="email" required autocomplete="email" />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input class="input" type="password" name="password" required autocomplete="current-password" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <div class="auth-switch">
      No account? <a href="#" data-view="signup">Register</a> ·
      <a href="#" data-view="reset">Forgot password?</a>
    </div>`;

  const signUpHTML = `
    <h2>Register</h2>
    <p class="sub">New accounts require administrator approval.</p>
    <form id="signup-form">
      <div class="form-group">
        <label>Full name</label>
        <input class="input" name="display_name" required minlength="2" />
      </div>
      <div class="form-group">
        <label>Email</label>
        <input class="input" type="email" name="email" required autocomplete="email" />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input class="input" type="password" name="password" required minlength="6" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>Confirm password</label>
        <input class="input" type="password" name="confirm" required minlength="6" autocomplete="new-password" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
    <div class="auth-switch">Already have an account? <a href="#" data-view="signin">Sign in</a></div>`;

  const resetHTML = `
    <h2>Reset password</h2>
    <p class="sub">We'll email you a recovery link.</p>
    <form id="reset-form">
      <div class="form-group">
        <label>Email</label>
        <input class="input" type="email" name="email" required autocomplete="email" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Send reset email</button>
    </form>
    <div class="auth-switch"><a href="#" data-view="signin">Back to sign in</a></div>`;

  const updatePasswordHTML = `
    <h2>Set a new password</h2>
    <p class="sub">Enter your new password below.</p>
    <form id="update-pw-form">
      <div class="form-group">
        <label>New password</label>
        <input class="input" type="password" name="password" required minlength="6" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>Confirm new password</label>
        <input class="input" type="password" name="confirm" required minlength="6" autocomplete="new-password" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Update password</button>
    </form>`;

  function render(viewName) {
    if (viewName === "signup") { view.innerHTML = signUpHTML; bindSignUp(); }
    else if (viewName === "reset") { view.innerHTML = resetHTML; bindReset(); }
    else if (viewName === "update-pw") { view.innerHTML = updatePasswordHTML; bindUpdatePw(); }
    else { view.innerHTML = signInHTML; bindSignIn(); }
    view.querySelectorAll("[data-view]").forEach(a => {
      a.addEventListener("click", (e) => { e.preventDefault(); render(a.dataset.view); });
    });
  }

  function bindSignIn() {
    document.getElementById("signin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      showLoading(true);
      const { data, error } = await window.db.auth.signInWithPassword({
        email: fd.email.trim(), password: fd.password
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      // fetch profile to check authorization
      const { data: profile } = await window.db.from("profiles")
        .select("is_authorized,is_active").eq("id", data.user.id).single();
      if (!profile) { toast("Profile missing. Contact admin.", "error"); return; }
      if (!profile.is_active) { await window.db.auth.signOut(); toast("Account disabled.", "error"); return; }
      if (!profile.is_authorized) { await window.db.auth.signOut(); toast("Awaiting administrator approval.", "warning", 5000); return; }
      window.location.replace("app.html");
    });
  }

  function bindSignUp() {
    document.getElementById("signup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      if (fd.password !== fd.confirm) { toast("Passwords do not match", "error"); return; }
      showLoading(true);
      const { error } = await window.db.auth.signUp({
        email: fd.email.trim(),
        password: fd.password,
        options: { data: { display_name: fd.display_name.trim() } }
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Account created. An administrator must approve it.", "success", 6000);
      render("signin");
    });
  }

  function bindReset() {
    document.getElementById("reset-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      showLoading(true);
      const { error } = await window.db.auth.resetPasswordForEmail(fd.email.trim(), {
        redirectTo: window.location.origin + window.location.pathname
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Reset link sent — check your inbox.", "success", 5000);
    });
  }

  function bindUpdatePw() {
    document.getElementById("update-pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      if (fd.password !== fd.confirm) { toast("Passwords do not match", "error"); return; }
      showLoading(true);
      const { error } = await window.db.auth.updateUser({ password: fd.password });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Password updated. Please sign in.", "success", 4000);
      await window.db.auth.signOut();
      setTimeout(() => window.location.replace("index.html"), 1200);
    });
  }

  // A recovery e-mail link lands here with "type=recovery" in the URL hash. Supabase signs the
  // user in with that link, so without this check the "already signed in" redirect below would
  // send them straight to the app and they could never set a new password.
  const isRecoveryLink = /(^|[#&?])type=recovery(&|$)/.test(window.location.hash + window.location.search);

  // Handle recovery link
  window.db.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") { render("update-pw"); }
  });

  // If already signed in and authorized, go to app
  (async () => {
    if (isRecoveryLink) { render("update-pw"); return; }
    const { data } = await window.db.auth.getSession();
    if (data.session) {
      const { data: p } = await window.db.from("profiles")
        .select("is_authorized,is_active").eq("id", data.session.user.id).single();
      if (p && p.is_authorized && p.is_active) { window.location.replace("app.html"); return; }
    }
    render("signin");
  })();
})();