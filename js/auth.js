(function () {
  const { toast, showLoading } = window.Utils;

  async function getSession() {
    const { data } = await window.db.auth.getSession();
    return data.session;
  }

  async function getProfile() {
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await window.db
      .from("profiles").select("*").eq("id", session.user.id).single();
    if (error) { console.error(error); return null; }
    return data;
  }

  async function signOut() {
    await window.db.auth.signOut();
    window.location.replace("index.html");
  }

  async function requireAuthorized() {
    const profile = await getProfile();
    if (!profile) { window.location.replace("index.html"); return null; }
    if (!profile.is_active) {
      toast("Your account has been disabled.", "error", 5000);
      await window.db.auth.signOut();
      setTimeout(() => window.location.replace("index.html"), 1500);
      return null;
    }
    if (!profile.is_authorized) {
      toast("Your account is awaiting administrator approval.", "warning", 6000);
      await window.db.auth.signOut();
      setTimeout(() => window.location.replace("index.html"), 1500);
      return null;
    }
    return profile;
  }

  async function logAction(action, table_name, record_id, description) {
    try {
      await window.db.rpc("log_user_action", {
        p_action: action, p_table_name: table_name,
        p_record_id: record_id, p_description: description
      });
    } catch (e) { console.warn("log failed", e); }
  }

  window.Auth = { getSession, getProfile, signOut, requireAuthorized, logAction };
})();