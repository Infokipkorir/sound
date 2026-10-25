/* SoundsCare shared configuration. Every page loads this with:
     <script src="config.js"></script>
   (place it BEFORE the page's own <script>). Change a key here once and every page picks it up.
   Only PUBLIC values belong here: this file can be read by anyone who knows its URL.
   Never put the Supabase service_role key or PASSKEY_SECRET in this file. */
window.SOUNDS_CONFIG = {
  supabaseUrl: 'https://phoahudvrcelfrykoeuo.supabase.co',
  supabaseKey: 'sb_publishable_s4Wljr3TEtjLRxNJ9DzRSw_17gtvoAb',
  passkeyFunction: 'admin-passkey'
};
