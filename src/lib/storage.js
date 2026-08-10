import { supabase } from "./supabaseClient";

// This mirrors the shape of the `window.storage` API used inside Claude
// artifacts (get/set/delete against a simple key-value store), backed by a
// `kv_store` table in Supabase instead. Values are stored as JSON text,
// matching how the original app always did JSON.stringify/parse itself.
//
// Since Google login was added, every row also carries the owning user's
// `user_id` (auth.uid()), and RLS policies restrict reads/writes to rows
// you own. set() looks up the current session on every call to attach it.

export const storage = {
  async get(key) {
    const { data, error } = await supabase
      .from("kv_store")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { key, value: data.value };
  },

  async set(key, value) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("kv_store")
      .upsert({ key, value, user_id: user ? user.id : null, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { key, value };
  },

  async delete(key) {
    const { error } = await supabase.from("kv_store").delete().eq("key", key);
    if (error) throw error;
    return { key, deleted: true };
  },

  async list(prefix) {
    let query = supabase.from("kv_store").select("key");
    if (prefix) query = query.like("key", `${prefix}%`);
    const { data, error } = await query;
    if (error) throw error;
    return { keys: (data || []).map((r) => r.key), prefix };
  },
};

