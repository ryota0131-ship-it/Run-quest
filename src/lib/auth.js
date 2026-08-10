import { supabase } from "./supabaseClient";

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Fetches the player's saved row for the *currently signed-in* user,
// looking it up by user_id (not by nickname — nickname is now just a
// display name and no longer needs to be unique).
export async function loadMyPlayerRow() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("kv_store")
    .select("key, value")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export function playerKeyForUser(userId) {
  return `runquest:${userId}`;
}
