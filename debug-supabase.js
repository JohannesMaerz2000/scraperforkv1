// Debug script to check Supabase globals
console.log('=== Debugging Supabase Globals ===');
console.log('window.supabase:', typeof window.supabase);
console.log('window.Supabase:', typeof window.Supabase);
console.log('window.createClient:', typeof window.createClient);
console.log('global supabase:', typeof supabase);
console.log('global Supabase:', typeof Supabase);
console.log('global createClient:', typeof createClient);

// List all window properties that might be related to supabase
const supabaseProps = Object.keys(window).filter(key => 
    key.toLowerCase().includes('supabase') || 
    key.toLowerCase().includes('client')
);
console.log('Supabase-related window properties:', supabaseProps);

// Try to find the createClient function
if (window.supabase && window.supabase.createClient) {
    console.log('✅ Found: window.supabase.createClient');
} else if (typeof createClient !== 'undefined') {
    console.log('✅ Found: global createClient');
} else {
    console.log('❌ createClient not found');
}