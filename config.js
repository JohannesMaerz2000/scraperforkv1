// Configuration file for Tennis.de Scraper Extension
// Replace these with your actual Supabase credentials

const CONFIG = {
    // Your Supabase project URL
    SUPABASE_URL: 'https://iwqofkukwxglsodczrfo.supabase.co',
    
    // Your Supabase anon/public key
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3cW9ma3Vrd3hnbHNvZGN6cmZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxODY1MTUsImV4cCI6MjA5MDc2MjUxNX0.GrjfD0_Umg1cw_7GF9xMLGD8VCJMHS80JeGvS2emO3Y',
    
    // Note: These credentials will be used for authentication
    // Users will sign in with their email/password that was created in your separate Tennis Player app
};

// Make config available globally
if (typeof window !== 'undefined') {
    window.CONFIG = CONFIG;
} else if (typeof self !== 'undefined') {
    self.CONFIG = CONFIG;
} else if (typeof globalThis !== 'undefined') {
    globalThis.CONFIG = CONFIG;
}