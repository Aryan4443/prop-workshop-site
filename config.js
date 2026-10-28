// Public settings for the Prop Workshop site. The publishable (anon) key is meant to be public:
// what people can read and write is decided by the access rules in supabase/setup.sql.
window.WORKSHOP_CONFIG = {
  supabaseUrl: 'PASTE_PROJECT_URL_HERE',
  supabaseKey: 'PASTE_PUBLISHABLE_KEY_HERE',
  emailDomain: 'csulb.edu',
  bucket: 'workshop'
};
