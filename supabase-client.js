// Simplified Supabase client for Tennis.de Scraper Extension
// Uses fetch API directly instead of Supabase SDK to avoid CSP issues

class SupabaseClient {
    constructor() {
        this.supabaseUrl = null;
        this.supabaseKey = null;
        this.isInitialized = false;
        this.currentUser = null;
        this.session = null;
        this.matchesTable = 'matches_v2';
        this.expHistoryBatchTable = 'exp_player_history_batches';
        this.expHistoryJobTable = 'exp_player_history_jobs';
        this.debugLogging = false;
    }

    debugLog(...args) {
        if (this.debugLogging) {
            console.log(...args);
        }
    }

    normalizeIdentityText(value) {
        return String(value || '')
            .normalize('NFC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    canonicalizeScoreDescriptor(score, isWalkover, isRetirement) {
        const normalizedScore = this.normalizeIdentityText(score);
        if (!normalizedScore || normalizedScore === 'n.a.' || isWalkover) {
            return 'walkover';
        }

        const hasRetirement = /\baufg\.?\b/.test(normalizedScore) || !!isRetirement;
        const scoreWithoutRetirement = normalizedScore.replace(/\baufg\.?\b/g, '').trim();
        const setTokens = scoreWithoutRetirement
            .split(/[\s/]+/)
            .map((token) => token.trim())
            .filter((token) => /^\d+:\d+(?:\s*\(\d+:\d+\))?$/.test(token))
            .map((token) => token.replace(/\s+/g, ''));

        const base = setTokens.length > 0 ? setTokens.join(' ') : scoreWithoutRetirement;
        return hasRetirement ? `${base} aufg.` : base;
    }

    async sha256Hex(input) {
        if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
            const encoded = new TextEncoder().encode(input);
            const digest = await crypto.subtle.digest('SHA-256', encoded);
            const bytes = Array.from(new Uint8Array(digest));
            return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
        }

        // Deterministic non-crypto fallback for environments without subtle crypto.
        let hash = 5381;
        for (let i = 0; i < input.length; i++) {
            hash = ((hash << 5) + hash) + input.charCodeAt(i);
            hash = hash >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    async buildMatchIdentityKeys(match) {
        const team1Player1 = this.normalizeIdentityText(match.team1_player1_name);
        const team1Player2 = this.normalizeIdentityText(match.team1_player2_name);
        const team2Player1 = this.normalizeIdentityText(match.team2_player1_name);
        const team2Player2 = this.normalizeIdentityText(match.team2_player2_name);
        const matchDate = this.normalizeIdentityText(match.match_date);
        const eventName = this.normalizeIdentityText(match.event_name);
        const canonicalScore = this.canonicalizeScoreDescriptor(
            match.normalized_score,
            match.is_walkover,
            match.is_retirement
        );

        const exactPayload = JSON.stringify({
            v: 2,
            participants: {
                t1: [team1Player1, team1Player2],
                t2: [team2Player1, team2Player2]
            },
            date: matchDate,
            event: eventName,
            score: canonicalScore,
            is_double: !!match.is_double,
            is_walkover: !!match.is_walkover,
            is_retirement: !!match.is_retirement
        });

        const softPayload = JSON.stringify({
            v: 2,
            participants: {
                t1: [team1Player1, team1Player2],
                t2: [team2Player1, team2Player2]
            },
            date: matchDate,
            score: canonicalScore,
            is_double: !!match.is_double,
            is_walkover: !!match.is_walkover,
            is_retirement: !!match.is_retirement
        });

        return {
            exactKey: await this.sha256Hex(exactPayload),
            softKey: await this.sha256Hex(softPayload)
        };
    }

    /**
     * Initialize Supabase client with authentication (new method)
     */
    async initialize(supabaseUrl, supabaseKey) {
        try {
            this.supabaseUrl = supabaseUrl.replace(/\/$/, ''); // Remove trailing slash
            this.supabaseKey = supabaseKey;
            
            // Check if we have the official Supabase client available
            let createClient;
            
            // Try different possible global variable names with more detailed checking
            if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
                createClient = window.supabase.createClient;
                console.log('✅ Found: window.supabase.createClient');
            } else if (typeof self !== 'undefined' && self.supabase && self.supabase.createClient) {
                createClient = self.supabase.createClient;
                console.log('✅ Found: self.supabase.createClient');
            } else if (typeof globalThis !== 'undefined' && globalThis.supabase && globalThis.supabase.createClient) {
                createClient = globalThis.supabase.createClient;
                console.log('✅ Found: globalThis.supabase.createClient');
            } else if (typeof supabase !== 'undefined' && supabase.createClient) {
                createClient = supabase.createClient;
                console.log('✅ Found: global supabase.createClient');
            } else {
                console.log('❌ Supabase client not found, available objects:', {
                    window_supabase: typeof window !== 'undefined' ? typeof window.supabase : 'undefined',
                    self_supabase: typeof self !== 'undefined' ? typeof self.supabase : 'undefined',
                    globalThis_supabase: typeof globalThis !== 'undefined' ? typeof globalThis.supabase : 'undefined',
                    global_supabase: typeof supabase
                });
                throw new Error('Official Supabase client is required for authentication');
            }
            
            // Use the official Supabase client
            this.client = createClient(supabaseUrl, supabaseKey);
            
            // Test connection
            const { data, error } = await this.client.from(this.matchesTable).select('count', { count: 'exact', head: true });
            
            if (error) {
                throw new Error(`Connection test failed: ${error.message}`);
            }
            
            this.isInitialized = true;
            console.log('✅ Supabase client initialized successfully with official client');
            
            // Don't store credentials in initialize - they will be stored after authentication
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Failed to initialize Supabase:', error);
            this.isInitialized = false;
            return { success: false, error: error.message };
        }
    }

    /**
     * Fallback initialization using fetch API
     */
    async initializeWithFetch(supabaseUrl, supabaseKey) {
        try {
            this.supabaseUrl = supabaseUrl.replace(/\/$/, ''); // Remove trailing slash
            this.supabaseKey = supabaseKey;
            
            // Test connection with a simple query (just check if table exists)
            const testUrl = `${this.supabaseUrl}/rest/v1/${this.matchesTable}?select=id&limit=1`;
            const testResponse = await fetch(testUrl, {
                method: 'GET',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
            
            if (!testResponse.ok) {
                const errorText = await testResponse.text();
                throw new Error(`Connection test failed: ${testResponse.status} ${testResponse.statusText} - ${errorText}`);
            }
            
            this.isInitialized = true;
            console.log('✅ Supabase client initialized successfully with fetch implementation');
            
            // Don't store credentials in fetch initialize - they will be stored after authentication
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Failed to initialize Supabase with fetch:', error);
            this.isInitialized = false;
            return { success: false, error: error.message };
        }
    }

    /**
     * Login with email and password using REST API
     */
    async signIn(email, password, supabaseUrl, supabaseKey) {
        try {
            // Set up the connection parameters
            this.supabaseUrl = supabaseUrl.replace(/\/$/, '');
            this.supabaseKey = supabaseKey;

            // Try to sign in using Supabase Auth REST API
            const response = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'apikey': this.supabaseKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: email,
                    password: password
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error_description || errorData.msg || `Authentication failed: ${response.status}`);
            }

            const authData = await response.json();

            if (!authData.access_token || !authData.user) {
                throw new Error('Authentication failed - no access token or user data returned');
            }

            // Create session object
            const session = {
                access_token: authData.access_token,
                refresh_token: authData.refresh_token,
                expires_in: authData.expires_in,
                expires_at: Math.round(Date.now() / 1000) + (authData.expires_in || 3600),
                token_type: authData.token_type || 'bearer'
            };

            this.currentUser = authData.user;
            this.session = session;
            this.isInitialized = true;

            // Store auth state and connection info
            await chrome.storage.local.set({
                supabaseUrl: supabaseUrl,
                supabaseKey: supabaseKey,
                supabaseConnected: true,
                userSession: session,
                userEmail: authData.user.email
            });

            console.log('✅ User signed in successfully:', authData.user.email);
            return { success: true, user: authData.user, session: session };

        } catch (error) {
            console.error('❌ Sign in failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sign out current user
     */
    async signOut() {
        try {
            if (this.client) {
                const { error } = await this.client.auth.signOut();
                if (error) {
                    console.warn('Warning during sign out:', error.message);
                }
            }

            // Clear local state
            this.currentUser = null;
            this.session = null;

            // Clear storage
            await chrome.storage.local.remove([
                'supabaseUrl', 'supabaseKey', 'supabaseConnected',
                'userSession', 'userEmail'
            ]);

            console.log('✅ User signed out successfully');
            return { success: true };

        } catch (error) {
            console.error('❌ Sign out failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return this.currentUser !== null && this.session !== null;
    }

    /**
     * Get current user
     */
    getCurrentUser() {
        return this.currentUser;
    }

    /**
     * Load saved session and restore authentication using REST API
     */
    async loadSavedSession() {
        try {
            const result = await chrome.storage.local.get([
                'supabaseUrl', 'supabaseKey', 'supabaseConnected',
                'userSession', 'userEmail'
            ]);
            
            if (result.userSession && result.supabaseUrl && result.supabaseKey) {
                // Set up connection parameters
                this.supabaseUrl = result.supabaseUrl.replace(/\/$/, '');
                this.supabaseKey = result.supabaseKey;
                
                // Check if session is expired
                const session = result.userSession;
                const now = Math.round(Date.now() / 1000);
                
                if (session.expires_at && session.expires_at <= now) {
                    console.log('📝 Session expired, attempting refresh...');
                    
                    // Try to refresh the session
                    if (session.refresh_token) {
                        const refreshResult = await this.refreshSession(session.refresh_token);
                        if (refreshResult.success) {
                            this.currentUser = refreshResult.user;
                            this.session = refreshResult.session;
                            this.isInitialized = true;
                            console.log('✅ Session refreshed for:', refreshResult.user.email);
                            return refreshResult;
                        }
                    }
                    
                    // If refresh failed, clear the session
                    console.log('❌ Session refresh failed, clearing session');
                    await this.signOut();
                    return { success: false, error: 'Session expired and refresh failed' };
                }
                
                // Session is still valid - restore it
                try {
                    // Verify the session is still valid by making a simple request
                    const userResponse = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
                        method: 'GET',
                        headers: {
                            'apikey': this.supabaseKey,
                            'Authorization': `Bearer ${session.access_token}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (userResponse.ok) {
                        const userData = await userResponse.json();
                        this.currentUser = userData;
                        this.session = session;
                        this.isInitialized = true;
                        console.log('✅ Session restored for:', userData.email);
                        return { success: true, user: userData, session: session };
                    } else {
                        throw new Error('Session validation failed');
                    }
                } catch (error) {
                    console.log('❌ Session validation failed:', error.message);
                    await this.signOut();
                    return { success: false, error: 'Session validation failed' };
                }
            }
            
            return { success: false, error: 'No saved session found' };
        } catch (error) {
            console.error('❌ Failed to load saved session:', error);
            await this.signOut(); // Clear any corrupted data
            return { success: false, error: error.message };
        }
    }

    /**
     * Refresh session using refresh token
     */
    async refreshSession(refreshToken) {
        try {
            const response = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: {
                    'apikey': this.supabaseKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    refresh_token: refreshToken
                })
            });

            if (!response.ok) {
                throw new Error(`Refresh failed: ${response.status}`);
            }

            const authData = await response.json();

            const session = {
                access_token: authData.access_token,
                refresh_token: authData.refresh_token,
                expires_in: authData.expires_in,
                expires_at: Math.round(Date.now() / 1000) + (authData.expires_in || 3600),
                token_type: authData.token_type || 'bearer'
            };

            // Update stored session
            await chrome.storage.local.set({
                userSession: session,
                userEmail: authData.user.email
            });

            return { success: true, user: authData.user, session: session };

        } catch (error) {
            console.error('❌ Session refresh failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Link user profile to a tennis.de player
     */
    async linkPlayerProfile(playerData) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                throw new Error('User not authenticated');
            }

            const response = await fetch(`${this.supabaseUrl}/rest/v1/rpc/link_player_profile`, {
                method: 'POST',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    p_dtb_id: parseInt(playerData.dtbId),
                    p_player_name: playerData.fullName,
                    p_tennis_club: this.stripClubIdSuffix(playerData.club),
                    p_profile_url: playerData.url
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `Failed to link profile: ${response.status}`);
            }

            const linkDataArray = await response.json();
            const linkData = linkDataArray[0]; // RPC functions return arrays
            console.log('✅ Player profile linked successfully:', linkData);
            
            return { success: true, data: linkData };

        } catch (error) {
            console.error('❌ Failed to link player profile:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if current user has a linked player profile
     */
    async checkPlayerLink() {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, hasLink: false, error: 'User not authenticated' };
            }

            const response = await fetch(`${this.supabaseUrl}/rest/v1/player_user_links?select=*`, {
                method: 'GET',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to check player link: ${response.status}`);
            }

            const linkData = await response.json();
            const hasLink = linkData.length > 0;
            
            return { 
                success: true, 
                hasLink: hasLink, 
                data: hasLink ? linkData[0] : null 
            };

        } catch (error) {
            console.error('❌ Failed to check player link:', error);
            return { success: false, hasLink: false, error: error.message };
        }
    }

    /**
     * Get current user's linked player profile
     */
    async getLinkedPlayerProfile() {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                throw new Error('User not authenticated');
            }

            const response = await fetch(`${this.supabaseUrl}/rest/v1/player_user_links?select=*`, {
                method: 'GET',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to get linked profile: ${response.status}`);
            }

            const linkData = await response.json();
            
            if (linkData.length === 0) {
                return { success: false, error: 'No linked profile found' };
            }

            return { success: true, data: linkData[0] };

        } catch (error) {
            console.error('❌ Failed to get linked player profile:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Unlink current user's player profile
     */
    async unlinkPlayerProfile() {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                throw new Error('User not authenticated');
            }

            const response = await fetch(`${this.supabaseUrl}/rest/v1/player_user_links`, {
                method: 'DELETE',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to unlink profile: ${response.status}`);
            }

            console.log('✅ Player profile unlinked successfully');
            return { success: true };

        } catch (error) {
            console.error('❌ Failed to unlink player profile:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Disconnect and clear credentials (legacy method - now uses signOut)
     */
    async disconnect() {
        return await this.signOut();
    }

    /**
     * Check if client is ready for operations
     */
    isReady() {
        return this.isInitialized && this.supabaseUrl && this.supabaseKey;
    }

    /**
     * Make HTTP request to Supabase REST API
     */
    async makeRequest(method, endpoint, data = null, requestOptions = {}) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }

        const url = `${this.supabaseUrl}${endpoint}`;
        
        // Use session token if authenticated, otherwise fall back to anon key
        const authToken = this.session?.access_token || this.supabaseKey;
        
        const headers = {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
            'Prefer': requestOptions.prefer || 'return=minimal'
        };

        const options = {
            method: method,
            headers: headers
        };

        if (data && (method === 'POST' || method === 'PATCH')) {
            options.body = JSON.stringify(data);
        }

        return await fetch(url, options);
    }

    /**
     * Upload player data to database
     */
    async uploadPlayerData(playerData) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }

        // Silently skip players without a valid DTB-ID — no dtb_id means no stable identity
        const dtbIdParsed = playerData.dtbId ? parseInt(playerData.dtbId, 10) : null;
        if (!dtbIdParsed || Number.isNaN(dtbIdParsed)) {
            console.log('⏭️ Skipping player upload: no valid DTB-ID', playerData.fullName);
            return { success: true, skipped: true };
        }

        try {
            const normalizedClubName = this.stripClubIdSuffix(playerData.club);
            const sourceClubIdFromName = this.extractClubIdFromText(playerData.club);
            const sourceClubId = playerData.clubId || sourceClubIdFromName || null;
            const mainClubId = await this.upsertClubFromPayload({
                sourceClubId,
                name: normalizedClubName || playerData.club
            });

            // Parse LK string (e.g. "LK 21,6" or "21,6") to numeric(4,1)
            const parsedLK = this.parseLkNumeric(playerData.leistungsklasse);

            // Prepare player data for database
            const dbPlayerData = {
                dtb_id: dtbIdParsed,
                full_name: playerData.fullName,
                leistungsklasse: parsedLK,
                club: normalizedClubName,
                main_club_id: mainClubId,
                nationality: playerData.nationality,
                association: playerData.association,
                profile_url: playerData.url,
                last_scraped: new Date().toISOString()
            };

            this.debugLog('🔄 Attempting to upload player data:', dbPlayerData);

            if (this.client) {
                // Use official Supabase client with better error handling
                const { data, error } = await this.client
                    .from('players')
                    .upsert(dbPlayerData, { 
                        onConflict: 'dtb_id',
                        ignoreDuplicates: false 
                    })
                    .select();

                if (error) {
                    console.error('❌ Supabase client error:', error);
                    throw new Error(`Failed to upload player data: ${error.message}`);
                }

                this.debugLog('✅ Player data uploaded successfully via Supabase client');
                return { success: true, data };
            } else {
                // Use fetch fallback with simpler logic
                this.debugLog('🔄 Using fetch API to upload player data...');
                
                // First, check if player exists (only if we have DTB ID)
                if (dbPlayerData.dtb_id) {
                    
                    const checkResponse = await this.makeRequest('GET', 
                        `/rest/v1/players?dtb_id=eq.${dbPlayerData.dtb_id}&select=dtb_id`
                    );
                    
                    if (checkResponse.ok) {
                        const existingPlayers = await checkResponse.json();
                        this.debugLog('🔍 Existing players found:', existingPlayers.length);
                        
                        if (existingPlayers.length > 0) {
                            // Player exists, update it
                            this.debugLog('🔄 Updating existing player...');
                            const updateResponse = await this.makeRequest('PATCH', 
                                `/rest/v1/players?dtb_id=eq.${dbPlayerData.dtb_id}`, 
                                dbPlayerData
                            );
                            
                            if (!updateResponse.ok) {
                                const errorText = await updateResponse.text();
                                throw new Error(`Failed to update player: ${updateResponse.status} ${errorText}`);
                            }
                            
                            this.debugLog('✅ Player data updated successfully');
                            return { success: true, data: dbPlayerData };
                        }
                    }
                }
                
                // Player doesn't exist, insert new one
                this.debugLog('🔄 Inserting new player...');
                const insertResponse = await this.makeRequest('POST', '/rest/v1/players', dbPlayerData);
                
                if (!insertResponse.ok) {
                    const errorText = await insertResponse.text();
                    console.error('❌ Insert failed:', insertResponse.status, errorText);
                    
                    // Check if it's a duplicate error from rapid requests
                    if (insertResponse.status === 409 && errorText.includes('duplicate key')) {
                        console.log('⚠️ Duplicate key error - likely from rapid requests. Treating as success.');
                        return { success: true, data: dbPlayerData };
                    }
                    
                    throw new Error(`Failed to insert player: ${insertResponse.status} ${errorText}`);
                }
                
                this.debugLog('✅ Player data inserted successfully');
                return { success: true, data: dbPlayerData };
            }

        } catch (error) {
            console.error('❌ Error uploading player data:', error);
            console.error('❌ Player data that failed:', playerData);
            
            // More specific duplicate handling
            if (error.message.includes('duplicate key') || 
                error.message.includes('23505') || 
                error.message.includes('players_dtb_id_key')) {
                console.log('⚠️ Duplicate key error detected. This might be from rapid requests or data already exists.');
                console.log('✅ Treating as success since player data is in database');
                return { success: true, data: 'Player already exists' };
            }
            
            throw error;
        }
    }

    /**
     * Upload matches in batches with conflict handling
     */
    async uploadMatches(matches, onProgress = null) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }

        if (!matches || matches.length === 0) {
            return { success: true, uploaded: 0, duplicates: 0, errors: 0 };
        }

        const batchSize = 50;
        let totalUploaded = 0;
        let totalDuplicates = 0;
        let totalErrors = 0;
        const errorDetails = [];
        const uploadedDbMatches = [];
        const scrapedPlayerInfo = await this.getScrapedPlayerInfoForUpload();

        console.log(`📦 Starting batch upload of ${matches.length} matches`);

        // Process matches in batches
        for (let i = 0; i < matches.length; i += batchSize) {
            const batch = matches.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(matches.length / batchSize);

            console.log(`🔄 Processing batch ${batchNumber}/${totalBatches} (${batch.length} matches)`);

            try {
                // Prepare batch data for database
                const dbMatches = [];
                for (const match of batch) {
                    const formattedMatch = await this.formatMatchForDatabase(match, scrapedPlayerInfo);
                    dbMatches.push(formattedMatch);
                    uploadedDbMatches.push(formattedMatch);
                }

                if (this.client) {
                    // Use official Supabase client with protective merge to avoid downgrading
                    // stronger existing values (e.g. winner_side, normalized_score) with weaker/null data.
                    const fingerprints = dbMatches
                        .map((m) => m.match_fingerprint)
                        .filter((f) => !!f);
                    const softKeys = dbMatches
                        .map((m) => m.soft_match_key)
                        .filter((k) => !!k);

                    const existingByFingerprint = new Map();
                    const existingBySoftKey = new Map();
                    if (fingerprints.length > 0) {
                        const { data: existingRows, error: existingError } = await this.client
                            .from(this.matchesTable)
                            .select(`
                                match_fingerprint,
                                soft_match_key,
                                match_date,
                                event_name,
                                is_double,
                                is_walkover,
                                is_retirement,
                                is_completed,
                                team1_player1_name,
                                team1_player1_lk,
                                team1_player1_lk_improvement,
                                team1_player1_dtb_id,
                                team1_player2_name,
                                team1_player2_lk,
                                team1_player2_lk_improvement,
                                team1_player2_dtb_id,
                                team2_player1_name,
                                team2_player1_lk,
                                team2_player1_lk_improvement,
                                team2_player1_dtb_id,
                                team2_player2_name,
                                team2_player2_lk,
                                team2_player2_lk_improvement,
                                team2_player2_dtb_id,
                                winner_side,
                                normalized_score
                            `)
                            .in('match_fingerprint', fingerprints);

                        if (existingError) {
                            console.warn('⚠️ Failed to load existing matches for protective merge:', existingError.message);
                        } else if (Array.isArray(existingRows)) {
                            for (const row of existingRows) {
                                if (row?.match_fingerprint) {
                                    existingByFingerprint.set(row.match_fingerprint, row);
                                }
                            }
                        }
                    }

                    if (softKeys.length > 0) {
                        const { data: existingSoftRows, error: existingSoftError } = await this.client
                            .from(this.matchesTable)
                            .select(`
                                match_fingerprint,
                                soft_match_key,
                                match_date,
                                event_name,
                                is_double,
                                is_walkover,
                                is_retirement,
                                is_completed,
                                team1_player1_name,
                                team1_player1_lk,
                                team1_player1_lk_improvement,
                                team1_player1_dtb_id,
                                team1_player2_name,
                                team1_player2_lk,
                                team1_player2_lk_improvement,
                                team1_player2_dtb_id,
                                team2_player1_name,
                                team2_player1_lk,
                                team2_player1_lk_improvement,
                                team2_player1_dtb_id,
                                team2_player2_name,
                                team2_player2_lk,
                                team2_player2_lk_improvement,
                                team2_player2_dtb_id,
                                winner_side,
                                normalized_score
                            `)
                            .in('soft_match_key', softKeys);

                        if (existingSoftError) {
                            console.warn('⚠️ Failed to load existing matches by soft key (column may not exist yet):', existingSoftError.message);
                        } else if (Array.isArray(existingSoftRows)) {
                            for (const row of existingSoftRows) {
                                if (!row?.soft_match_key) continue;
                                if (!existingBySoftKey.has(row.soft_match_key)) {
                                    existingBySoftKey.set(row.soft_match_key, []);
                                }
                                existingBySoftKey.get(row.soft_match_key).push(row);
                            }
                        }
                    }

                    const mergedMatches = dbMatches.map((incoming) => {
                        const exactExisting = existingByFingerprint.get(incoming.match_fingerprint);
                        if (exactExisting) {
                            incoming.identity_confidence = 'high';
                            incoming.is_identity_ambiguous = false;
                            return this.mergeMatchForUpsert(incoming, exactExisting);
                        }

                        const softMatches = existingBySoftKey.get(incoming.soft_match_key) || [];
                        if (softMatches.length === 1) {
                            const matched = softMatches[0];
                            // Reuse canonical exact key of existing row so we update rather than insert duplicates.
                            incoming.match_fingerprint = matched.match_fingerprint;
                            incoming.identity_confidence = 'medium';
                            incoming.is_identity_ambiguous = false;
                            return this.mergeMatchForUpsert(incoming, matched);
                        }

                        if (softMatches.length > 1) {
                            console.warn(`⚠️ Ambiguous soft-key resolution for ${incoming.match_fingerprint}; keeping as separate exact match`);
                            incoming.identity_confidence = 'low';
                            incoming.is_identity_ambiguous = true;
                        } else {
                            incoming.identity_confidence = 'high';
                            incoming.is_identity_ambiguous = false;
                        }

                        return incoming;
                    });

                    const { data, error } = await this.client
                        .from(this.matchesTable)
                        .upsert(mergedMatches, { 
                            onConflict: 'match_fingerprint',
                            ignoreDuplicates: false  // Return info about what was updated vs inserted
                        })
                        .select('match_fingerprint');

                    if (error) {
                        console.error(`❌ Batch ${batchNumber} failed:`, error);
                        totalErrors += batch.length;
                        errorDetails.push({
                            batch: batchNumber,
                            error: error.message,
                            matchCount: batch.length
                        });
                    } else {
                        const uploadedCount = data ? data.length : 0;
                        const duplicateCount = batch.length - uploadedCount;
                        
                        totalUploaded += uploadedCount;
                        totalDuplicates += duplicateCount;
                        
                        console.log(`✅ Batch ${batchNumber}: ${uploadedCount} new/updated, ${duplicateCount} unchanged duplicates`);
                    }
                } else {
                    const {
                        uploadedCount,
                        duplicateCount,
                        errorCount,
                        errorMessage
                    } = await this.uploadBatchWithFetch(dbMatches);

                    totalUploaded += uploadedCount;
                    totalDuplicates += duplicateCount;
                    totalErrors += errorCount;

                    if (errorCount > 0 && errorMessage) {
                        errorDetails.push({
                            batch: batchNumber,
                            error: errorMessage,
                            matchCount: batch.length
                        });
                    }

                    console.log(`✅ Batch ${batchNumber}: ${uploadedCount} new, ${duplicateCount} updated/duplicates, ${errorCount} errors`);
                }

                // Update progress
                if (onProgress) {
                    const progressPercent = Math.round(((i + batch.length) / matches.length) * 100);
                    onProgress({
                        percent: progressPercent,
                        uploaded: totalUploaded,
                        duplicates: totalDuplicates,
                        errors: totalErrors,
                        batch: batchNumber,
                        totalBatches: totalBatches
                    });
                }

                // Rate limiting: small delay between batches
                if (i + batchSize < matches.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

            } catch (batchError) {
                console.error(`❌ Unexpected error in batch ${batchNumber}:`, batchError);
                totalErrors += batch.length;
                errorDetails.push({
                    batch: batchNumber,
                    error: batchError.message,
                    matchCount: batch.length
                });
            }
        }

        // Update DTB IDs for newly uploaded matches
        if (totalUploaded > 0) {
            await this.updateMissingDtbIds(uploadedDbMatches);
        }

        const result = {
            success: totalErrors === 0,
            uploaded: totalUploaded,
            duplicates: totalDuplicates,
            errors: totalErrors,
            errorDetails: errorDetails,
            total: matches.length
        };

        console.log(`🎉 Upload completed:`, result);
        return result;
    }

    async getScrapedPlayerInfoForUpload() {
        try {
            const result = await chrome.storage.local.get(['playerData']);
            if (!result.playerData || !result.playerData.dtbId) {
                return { fullName: null, dtbId: null };
            }
            return {
                fullName: result.playerData.fullName || null,
                dtbId: parseInt(result.playerData.dtbId, 10)
            };
        } catch (error) {
            console.warn('⚠️ Could not pre-load scraped player info for upload:', error);
            return { fullName: null, dtbId: null };
        }
    }

    async uploadBatchWithFetch(dbMatches) {
        if (!Array.isArray(dbMatches) || dbMatches.length === 0) {
            return { uploadedCount: 0, duplicateCount: 0, errorCount: 0, errorMessage: null };
        }

        try {
            const fingerprints = dbMatches
                .map((m) => m.match_fingerprint)
                .filter((f) => !!f);

            const selectFields = [
                'match_fingerprint',
                'soft_match_key',
                'match_date',
                'event_name',
                'is_double',
                'is_walkover',
                'is_retirement',
                'is_completed',
                'team1_player1_name',
                'team1_player1_lk',
                'team1_player1_lk_improvement',
                'team1_player1_dtb_id',
                'team1_player2_name',
                'team1_player2_lk',
                'team1_player2_lk_improvement',
                'team1_player2_dtb_id',
                'team2_player1_name',
                'team2_player1_lk',
                'team2_player1_lk_improvement',
                'team2_player1_dtb_id',
                'team2_player2_name',
                'team2_player2_lk',
                'team2_player2_lk_improvement',
                'team2_player2_dtb_id',
                'winner_side',
                'normalized_score'
            ].join(',');

            const existingByFingerprint = new Map();
            if (fingerprints.length > 0) {
                const inList = fingerprints.map((f) => encodeURIComponent(f)).join(',');
                const checkResponse = await this.makeRequest(
                    'GET',
                    `/rest/v1/${this.matchesTable}?match_fingerprint=in.(${inList})&select=${selectFields}`
                );

                if (!checkResponse.ok) {
                    const checkError = await checkResponse.text();
                    throw new Error(`Failed to load existing matches: ${checkResponse.status} ${checkError}`);
                }

                const existingRows = await checkResponse.json();
                if (Array.isArray(existingRows)) {
                    for (const row of existingRows) {
                        if (row?.match_fingerprint) {
                            existingByFingerprint.set(row.match_fingerprint, row);
                        }
                    }
                }
            }

            let uploadedCount = 0;
            let duplicateCount = 0;
            const mergedMatches = dbMatches.map((incoming) => {
                const existing = existingByFingerprint.get(incoming.match_fingerprint);
                if (existing) {
                    duplicateCount++;
                    return this.mergeMatchForUpsert(incoming, existing);
                }
                uploadedCount++;
                return incoming;
            });

            const upsertResponse = await this.makeRequest(
                'POST',
                `/rest/v1/${this.matchesTable}?on_conflict=match_fingerprint`,
                mergedMatches,
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );

            if (!upsertResponse.ok) {
                const upsertError = await upsertResponse.text();
                throw new Error(`Batch upsert failed: ${upsertResponse.status} ${upsertError}`);
            }

            this.debugLog(`✅ Fetch batch upsert successful (${uploadedCount} inserts, ${duplicateCount} updates)`);
            return { uploadedCount, duplicateCount, errorCount: 0, errorMessage: null };
        } catch (error) {
            console.error('❌ Fetch batch upload failed:', error);
            return {
                uploadedCount: 0,
                duplicateCount: 0,
                errorCount: dbMatches.length,
                errorMessage: error.message
            };
        }
    }

    /**
     * Format match data for database insertion
     */
    async formatMatchForDatabase(match, scrapedPlayerInfo = null) {
        const identityKeys = await this.buildMatchIdentityKeys(match);
        
        // Get DTB IDs for all players asynchronously
        const team1Player1Dtb = await this.extractDtbId(match.scraped_from_player, match.team1_player1_name, scrapedPlayerInfo);
        const team1Player2Dtb = await this.extractDtbId(match.scraped_from_player, match.team1_player2_name, scrapedPlayerInfo);
        const team2Player1Dtb = await this.extractDtbId(match.scraped_from_player, match.team2_player1_name, scrapedPlayerInfo);
        const team2Player2Dtb = await this.extractDtbId(match.scraped_from_player, match.team2_player2_name, scrapedPlayerInfo);

        let winnerSide = null;
        if (match.winner_side === 1 || match.winner_side === 2) {
            winnerSide = match.winner_side;
        } else if (typeof match.team1_wins === 'boolean') {
            // Legacy compatibility fallback
            winnerSide = match.team1_wins ? 1 : 2;
        }

        return {
            match_fingerprint: identityKeys.exactKey,
            soft_match_key: identityKeys.softKey,
            fingerprint_version: 2,
            identity_confidence: 'high',
            is_identity_ambiguous: false,
            match_date: match.match_date,
            event_name: match.event_name,
            
            // Match characteristics
            is_double: match.is_double,
            is_walkover: match.is_walkover,
            is_retirement: match.is_retirement,
            is_completed: match.is_completed,
            
            // Team 1
            team1_player1_name: match.team1_player1_name,
            team1_player1_lk: match.team1_player1_lk ?? null,
            team1_player1_lk_improvement: match.team1_player1_lk_improvement ?? null,
            team1_player1_dtb_id: team1Player1Dtb,
            team1_player2_name: match.team1_player2_name,
            team1_player2_lk: match.team1_player2_lk ?? null,
            team1_player2_lk_improvement: match.team1_player2_lk_improvement ?? null,
            team1_player2_dtb_id: team1Player2Dtb,
            
            // Team 2
            team2_player1_name: match.team2_player1_name,
            team2_player1_lk: match.team2_player1_lk ?? null,
            team2_player1_lk_improvement: match.team2_player1_lk_improvement ?? null,
            team2_player1_dtb_id: team2Player1Dtb,
            team2_player2_name: match.team2_player2_name,
            team2_player2_lk: match.team2_player2_lk ?? null,
            team2_player2_lk_improvement: match.team2_player2_lk_improvement ?? null,
            team2_player2_dtb_id: team2Player2Dtb,
            
            // Results
            winner_side: winnerSide,
            normalized_score: match.normalized_score,
            
            // Metadata
            scraped_at: match.scraped_at,
            source_url: match.source_url
        };
    }

    /**
     * Merge incoming match row with existing DB row, never downgrading stronger existing values.
     */
    mergeMatchForUpsert(incoming, existing) {
        if (!existing) {
            return incoming;
        }

        const merged = { ...incoming };
        const preserveIfIncomingWeak = [
            'match_date',
            'event_name',
            'is_double',
            'is_walkover',
            'is_retirement',
            'is_completed',
            'team1_player1_name',
            'team1_player1_lk',
            'team1_player1_lk_improvement',
            'team1_player1_dtb_id',
            'team1_player2_name',
            'team1_player2_lk',
            'team1_player2_lk_improvement',
            'team1_player2_dtb_id',
            'team2_player1_name',
            'team2_player1_lk',
            'team2_player1_lk_improvement',
            'team2_player1_dtb_id',
            'team2_player2_name',
            'team2_player2_lk',
            'team2_player2_lk_improvement',
            'team2_player2_dtb_id',
            'normalized_score',
            'soft_match_key'
        ];

        for (const field of preserveIfIncomingWeak) {
            const incomingValue = merged[field];
            const existingValue = existing[field];
            const incomingIsWeak = incomingValue === null || incomingValue === undefined || incomingValue === '';
            const existingIsStrong = existingValue !== null && existingValue !== undefined && existingValue !== '';

            if (incomingIsWeak && existingIsStrong) {
                merged[field] = existingValue;
            }
        }

        // Winner must never be downgraded from known to unknown.
        if ((merged.winner_side === null || merged.winner_side === undefined) &&
            (existing.winner_side === 1 || existing.winner_side === 2)) {
            merged.winner_side = existing.winner_side;
        }

        return merged;
    }

    /**
     * Extract DTB ID for known player (synchronous version)
     */
    async extractDtbId(scrapedPlayer, playerName, scrapedPlayerInfo = null) {
        // Only set DTB ID if this is the scraped player
        if (scrapedPlayer === playerName) {
            if (scrapedPlayerInfo && Number.isInteger(scrapedPlayerInfo.dtbId)) {
                return scrapedPlayerInfo.dtbId;
            }

            try {
                const result = await chrome.storage.local.get(['playerData']);
                if (result.playerData && result.playerData.dtbId) {
                    return parseInt(result.playerData.dtbId, 10);
                } else {
                    this.debugLog(`⚠️ No DTB ID found for scraped player ${playerName}`);
                    return null;
                }
            } catch (error) {
                console.error(`❌ Error getting DTB ID for ${playerName}:`, error);
                return null;
            }
        }
        return null;
    }

    /**
     * Update missing DTB IDs for players we have data for
     */
    async updateMissingDtbIds(matches) {
        try {
            console.log('🔄 Updating missing DTB IDs for current scrape batch...');
            
            // Get current player data
            const result = await chrome.storage.local.get(['playerData']);
            if (!result.playerData || !result.playerData.dtbId) {
                return;
            }

            const playerName = result.playerData.fullName;
            const dtbId = parseInt(result.playerData.dtbId);
            if (!playerName || !dtbId || Number.isNaN(dtbId)) {
                return;
            }

            const normalizedPlayerName = this.normalizeIdentityText(playerName);
            const fingerprints = (Array.isArray(matches) ? matches : [])
                .filter((m) => {
                    if (!m?.match_fingerprint) return false;
                    return [
                        m.team1_player1_name,
                        m.team1_player2_name,
                        m.team2_player1_name,
                        m.team2_player2_name
                    ].some((name) => this.normalizeIdentityText(name) === normalizedPlayerName);
                })
                .map((m) => m.match_fingerprint);

            const uniqueFingerprints = Array.from(new Set(fingerprints));
            if (uniqueFingerprints.length === 0) {
                this.debugLog('ℹ️ No batch-scoped fingerprints found for DTB backfill');
                return;
            }

            const chunkSize = 100;
            let updatesSucceeded = 0;
            const encodedName = encodeURIComponent(playerName);

            for (let i = 0; i < uniqueFingerprints.length; i += chunkSize) {
                const chunk = uniqueFingerprints.slice(i, i + chunkSize);
                const inList = chunk.map((f) => encodeURIComponent(f)).join(',');

                // Update each player slot only for matches in this scrape batch.
                const update1 = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/${this.matchesTable}?match_fingerprint=in.(${inList})&team1_player1_name=eq.${encodedName}&team1_player1_dtb_id=is.null`,
                    { team1_player1_dtb_id: dtbId }
                );
                const update2 = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/${this.matchesTable}?match_fingerprint=in.(${inList})&team2_player1_name=eq.${encodedName}&team2_player1_dtb_id=is.null`,
                    { team2_player1_dtb_id: dtbId }
                );
                const update3 = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/${this.matchesTable}?match_fingerprint=in.(${inList})&team1_player2_name=eq.${encodedName}&team1_player2_dtb_id=is.null`,
                    { team1_player2_dtb_id: dtbId }
                );
                const update4 = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/${this.matchesTable}?match_fingerprint=in.(${inList})&team2_player2_name=eq.${encodedName}&team2_player2_dtb_id=is.null`,
                    { team2_player2_dtb_id: dtbId }
                );

                if (update1.ok) updatesSucceeded++;
                if (update2.ok) updatesSucceeded++;
                if (update3.ok) updatesSucceeded++;
                if (update4.ok) updatesSucceeded++;
            }

            if (updatesSucceeded > 0) {
                console.log(`✅ Batch-scoped DTB backfill completed for player: ${playerName} (${dtbId})`);
            } else {
                console.warn('⚠️ Batch-scoped DTB backfill requests failed');
            }

        } catch (error) {
            console.error('❌ Error in updateMissingDtbIds:', error);
        }
    }

    isIsoDate(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    }

    maxIsoDate(a, b) {
        if (!this.isIsoDate(a)) return this.isIsoDate(b) ? b : null;
        if (!this.isIsoDate(b)) return a;
        return a >= b ? a : b;
    }

    minIsoDate(a, b) {
        if (!this.isIsoDate(a)) return this.isIsoDate(b) ? b : null;
        if (!this.isIsoDate(b)) return a;
        return a <= b ? a : b;
    }

    getDateRangeFromMatches(matches) {
        let latest = null;
        let oldest = null;
        for (const match of matches || []) {
            const date = match?.match_date;
            if (!this.isIsoDate(date)) continue;
            latest = this.maxIsoDate(latest, date);
            oldest = this.minIsoDate(oldest, date);
        }
        return { latest, oldest };
    }

    /**
     * Read per-player history sync state.
     */
    async getPlayerHistoryState(dtbId) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!dtbId) {
            return { success: false, error: 'DTB ID is required' };
        }

        const numericDtbId = parseInt(dtbId, 10);
        const selectFields = [
            'dtb_id',
            'history_backfill_completed',
            'history_backfill_completed_at',
            'history_last_synced_at',
            'history_latest_match_date',
            'history_oldest_match_date',
            'history_last_sync_mode',
            'history_last_sync_status'
        ].join(',');

        try {
            if (this.client) {
                const { data, error } = await this.client
                    .from('players')
                    .select(selectFields)
                    .eq('dtb_id', numericDtbId)
                    .maybeSingle();

                if (error) {
                    throw new Error(error.message || 'Failed to fetch player history state');
                }

                return { success: true, exists: !!data, data: data || null };
            }

            const response = await this.makeRequest(
                'GET',
                `/rest/v1/players?dtb_id=eq.${numericDtbId}&select=${encodeURIComponent(selectFields)}&limit=1`
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to fetch player history state: ${response.status} ${errorText}`);
            }

            const rows = await response.json();
            const data = rows?.[0] || null;
            return { success: true, exists: !!data, data };
        } catch (error) {
            console.error('❌ Error getting player history state:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Persist history sync status after a scrape+upload cycle.
     */
    async updatePlayerHistoryAfterSync({
        dtbId,
        mode,
        matches,
        scrapeMeta,
        uploadResult
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!dtbId) {
            return { success: false, error: 'DTB ID is required' };
        }

        const numericDtbId = parseInt(dtbId, 10);
        const nowIso = new Date().toISOString();
        const nowDateIso = nowIso.slice(0, 10);
        const currentStateResult = await this.getPlayerHistoryState(numericDtbId);
        const currentState = currentStateResult?.data || null;
        const dateRange = this.getDateRangeFromMatches(matches || []);

        const payload = {
            history_last_sync_mode: mode || null,
            history_last_sync_status: uploadResult?.success ? 'success' : 'failed',
            history_last_synced_at: nowIso
        };

        const mergedLatest = this.maxIsoDate(currentState?.history_latest_match_date, dateRange.latest);
        if (mergedLatest) {
            payload.history_latest_match_date = mergedLatest;
        }

        const mergedOldest = this.minIsoDate(currentState?.history_oldest_match_date, dateRange.oldest);
        if (mergedOldest) {
            payload.history_oldest_match_date = mergedOldest;
        }

        const reachedHistoryStart = !!scrapeMeta?.reachedHistoryStart;
        const hadFatalError = !!scrapeMeta?.hadFatalError;
        const fullBackfillCompletedNow =
            mode === 'full_backfill' &&
            !!uploadResult?.success &&
            reachedHistoryStart &&
            !hadFatalError;

        if (fullBackfillCompletedNow) {
            payload.history_backfill_completed = true;
            payload.history_backfill_completed_at =
                currentState?.history_backfill_completed_at || nowIso;
            payload.history_oldest_match_date = dateRange.oldest || payload.history_oldest_match_date || nowDateIso;
        }

        try {
            if (this.client) {
                const { data, error } = await this.client
                    .from('players')
                    .update(payload)
                    .eq('dtb_id', numericDtbId)
                    .select('dtb_id,history_backfill_completed,history_latest_match_date,history_oldest_match_date,history_last_synced_at,history_last_sync_mode,history_last_sync_status')
                    .maybeSingle();

                if (error) {
                    throw new Error(error.message || 'Failed to update player history state');
                }

                return { success: true, data };
            }

            const response = await this.makeRequest(
                'PATCH',
                `/rest/v1/players?dtb_id=eq.${numericDtbId}`,
                payload,
                { prefer: 'return=representation' }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to update player history state: ${response.status} ${errorText}`);
            }

            const rows = await response.json();
            return { success: true, data: rows?.[0] || null };
        } catch (error) {
            console.error('❌ Error updating player history state:', error);
            return { success: false, error: error.message };
        }
    }

    async expEnsurePlayerHistoryBatch({
        batchKey,
        label,
        teamPortraitUrl,
        targetCount,
        status = 'active'
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchKey) {
            return { success: false, error: 'batchKey is required' };
        }

        try {
            const lookup = await this.makeRequest(
                'GET',
                `/rest/v1/${this.expHistoryBatchTable}?batch_key=eq.${encodeURIComponent(String(batchKey))}&select=*&limit=1`
            );
            if (!lookup.ok) {
                const text = await lookup.text();
                throw new Error(`Failed to lookup batch: ${lookup.status} ${text}`);
            }

            const existingRows = await lookup.json();
            const existing = existingRows?.[0] || null;
            if (existing?.id) {
                const patch = {
                    status: status || 'active',
                    last_error: null,
                    team_portrait_url: teamPortraitUrl ? String(teamPortraitUrl) : existing.team_portrait_url,
                    target_count: Number.isInteger(targetCount) ? targetCount : (existing.target_count || 0)
                };
                const patched = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/${this.expHistoryBatchTable}?id=eq.${encodeURIComponent(existing.id)}`,
                    patch,
                    { prefer: 'return=representation' }
                );
                if (!patched.ok) {
                    const text = await patched.text();
                    throw new Error(`Failed to update batch: ${patched.status} ${text}`);
                }
                const patchedRows = await patched.json();
                return { success: true, data: patchedRows?.[0] || existing };
            }

            const payload = [{
                batch_key: String(batchKey),
                label: label ? String(label) : String(batchKey),
                team_portrait_url: teamPortraitUrl ? String(teamPortraitUrl) : null,
                target_count: Number.isInteger(targetCount) ? targetCount : 0,
                status: status || 'active',
                started_at: new Date().toISOString(),
                created_by_user_id: this.currentUser?.id || null
            }];

            const insert = await this.makeRequest(
                'POST',
                `/rest/v1/${this.expHistoryBatchTable}`,
                payload,
                { prefer: 'return=representation' }
            );
            if (!insert.ok) {
                const text = await insert.text();
                throw new Error(`Failed to create batch: ${insert.status} ${text}`);
            }
            const insertedRows = await insert.json();
            return { success: true, data: insertedRows?.[0] || null };
        } catch (error) {
            console.error('❌ expEnsurePlayerHistoryBatch failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expUpsertPlayerHistoryJobs({
        batchId,
        players,
        maxAttempts = 3,
        defaultPriority = 100
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId) {
            return { success: false, error: 'batchId is required' };
        }

        const rows = (Array.isArray(players) ? players : [])
            .map((player) => {
                const dtb = parseInt(player?.dtbId, 10);
                if (!dtb || Number.isNaN(dtb)) return null;
                return {
                    batch_id: batchId,
                    dtb_id: dtb,
                    player_name: player?.name ? String(player.name) : null,
                    source_team_id: player?.sourceTeamId ? String(player.sourceTeamId) : null,
                    source_rank: Number.isInteger(player?.rank) ? player.rank : null,
                    max_attempts: Number.isInteger(maxAttempts) ? maxAttempts : 3,
                    priority: Number.isInteger(player?.priority) ? player.priority : defaultPriority
                };
            })
            .filter(Boolean);

        if (rows.length === 0) {
            return { success: true, upserted: 0 };
        }

        try {
            const response = await this.makeRequest(
                'POST',
                `/rest/v1/${this.expHistoryJobTable}?on_conflict=batch_id,dtb_id`,
                rows,
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to upsert jobs: ${response.status} ${text}`);
            }

            const data = await response.json();
            return { success: true, upserted: Array.isArray(data) ? data.length : rows.length };
        } catch (error) {
            console.error('❌ expUpsertPlayerHistoryJobs failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expClaimNextPlayerHistoryJob({
        batchId,
        workerId = 'background-worker'
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId) {
            return { success: false, error: 'batchId is required' };
        }

        const nowIso = new Date().toISOString();

        try {
            // 1) Prefer pending jobs first, ordered by explicit source_rank to keep human-expected order.
            const pendingEndpoint = `/rest/v1/${this.expHistoryJobTable}?batch_id=eq.${encodeURIComponent(batchId)}&status=eq.pending&order=priority.asc,source_rank.asc.nullslast,created_at.asc,id.asc&limit=25&select=*`;
            const pendingLookup = await this.makeRequest('GET', pendingEndpoint);
            if (!pendingLookup.ok) {
                const text = await pendingLookup.text();
                throw new Error(`Failed to find pending jobs: ${pendingLookup.status} ${text}`);
            }

            let jobs = await pendingLookup.json();

            // 2) If no pending jobs are available, continue with retryable failed jobs.
            if (!Array.isArray(jobs) || jobs.length === 0) {
                const retryOrFilter = `(next_retry_at.is.null,next_retry_at.lte.${nowIso})`;
                const failedEndpoint = `/rest/v1/${this.expHistoryJobTable}?batch_id=eq.${encodeURIComponent(batchId)}&status=eq.failed&or=${encodeURIComponent(retryOrFilter)}&order=priority.asc,source_rank.asc.nullslast,created_at.asc,id.asc&limit=25&select=*`;
                const failedLookup = await this.makeRequest('GET', failedEndpoint);
                if (!failedLookup.ok) {
                    const text = await failedLookup.text();
                    throw new Error(`Failed to find retryable failed jobs: ${failedLookup.status} ${text}`);
                }
                jobs = await failedLookup.json();
            }

            const job = (jobs || []).find((candidate) => {
                const attempts = Number.isInteger(candidate?.attempt_count) ? candidate.attempt_count : 0;
                const maxAttempts = Number.isInteger(candidate?.max_attempts) ? candidate.max_attempts : 3;
                return attempts < maxAttempts;
            });
            if (!job?.id) {
                return { success: true, data: null };
            }

            const patch = {
                status: 'running',
                attempt_count: (Number.isInteger(job.attempt_count) ? job.attempt_count : 0) + 1,
                last_started_at: nowIso,
                locked_at: nowIso,
                locked_by: workerId
            };
            const claim = await this.makeRequest(
                'PATCH',
                `/rest/v1/${this.expHistoryJobTable}?id=eq.${encodeURIComponent(job.id)}`,
                patch,
                { prefer: 'return=representation' }
            );

            if (!claim.ok) {
                const text = await claim.text();
                throw new Error(`Failed to claim job ${job.id}: ${claim.status} ${text}`);
            }

            const claimedRows = await claim.json();
            return { success: true, data: claimedRows?.[0] || null };
        } catch (error) {
            console.error('❌ expClaimNextPlayerHistoryJob failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expCompletePlayerHistoryJob({
        jobId,
        syncMode,
        matchesScraped = 0,
        meta = null
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!jobId) {
            return { success: false, error: 'jobId is required' };
        }

        try {
            const patch = {
                status: 'completed',
                last_finished_at: new Date().toISOString(),
                last_sync_mode: syncMode || null,
                matches_scraped: Number.isInteger(matchesScraped) ? matchesScraped : 0,
                meta: meta || {}
            };
            const response = await this.makeRequest(
                'PATCH',
                `/rest/v1/${this.expHistoryJobTable}?id=eq.${encodeURIComponent(jobId)}`,
                patch,
                { prefer: 'return=representation' }
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to complete job: ${response.status} ${text}`);
            }
            const rows = await response.json();
            return { success: true, data: rows?.[0] || null };
        } catch (error) {
            console.error('❌ expCompletePlayerHistoryJob failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expFailPlayerHistoryJob({
        jobId,
        errorCode,
        errorMessage,
        retryDelaySeconds = 90
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!jobId) {
            return { success: false, error: 'jobId is required' };
        }

        try {
            const retryAt = new Date(Date.now() + Math.max(0, retryDelaySeconds) * 1000).toISOString();
            const patch = {
                status: 'failed',
                last_finished_at: new Date().toISOString(),
                next_retry_at: retryAt,
                last_error_code: errorCode ? String(errorCode) : 'UNKNOWN',
                last_error_message: errorMessage ? String(errorMessage) : null
            };
            const response = await this.makeRequest(
                'PATCH',
                `/rest/v1/${this.expHistoryJobTable}?id=eq.${encodeURIComponent(jobId)}`,
                patch,
                { prefer: 'return=representation' }
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to fail job: ${response.status} ${text}`);
            }
            const rows = await response.json();
            return { success: true, data: rows?.[0] || null };
        } catch (error) {
            console.error('❌ expFailPlayerHistoryJob failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expUpdatePlayerHistoryBatchStatus({
        batchId,
        status,
        lastError = null,
        finished = false
    }) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId) {
            return { success: false, error: 'batchId is required' };
        }

        try {
            const patch = {
                status: status || 'active',
                last_error: lastError || null
            };
            if (finished) {
                patch.finished_at = new Date().toISOString();
            }

            const response = await this.makeRequest(
                'PATCH',
                `/rest/v1/${this.expHistoryBatchTable}?id=eq.${encodeURIComponent(batchId)}`,
                patch,
                { prefer: 'return=representation' }
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to update batch status: ${response.status} ${text}`);
            }
            const rows = await response.json();
            return { success: true, data: rows?.[0] || null };
        } catch (error) {
            console.error('❌ expUpdatePlayerHistoryBatchStatus failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expRefreshPlayerHistoryBatchCounters(batchId) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId) {
            return { success: false, error: 'batchId is required' };
        }

        try {
            const response = await this.makeRequest(
                'GET',
                `/rest/v1/${this.expHistoryJobTable}?batch_id=eq.${encodeURIComponent(batchId)}&select=status`
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load batch jobs: ${response.status} ${text}`);
            }

            const rows = await response.json();
            const counters = {
                seed_count: rows.length,
                completed_count: rows.filter((row) => row?.status === 'completed').length,
                failed_count: rows.filter((row) => row?.status === 'failed').length
            };

            const patchResponse = await this.makeRequest(
                'PATCH',
                `/rest/v1/${this.expHistoryBatchTable}?id=eq.${encodeURIComponent(batchId)}`,
                counters,
                { prefer: 'return=representation' }
            );
            if (!patchResponse.ok) {
                const text = await patchResponse.text();
                throw new Error(`Failed to update counters: ${patchResponse.status} ${text}`);
            }

            const patched = await patchResponse.json();
            return { success: true, data: patched?.[0] || null, counters };
        } catch (error) {
            console.error('❌ expRefreshPlayerHistoryBatchCounters failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expGetPlayerHistoryBatchSummary({ batchId = null, batchKey = null } = {}) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId && !batchKey) {
            return { success: false, error: 'batchId or batchKey is required' };
        }

        try {
            const filter = batchId
                ? `id=eq.${encodeURIComponent(String(batchId))}`
                : `batch_key=eq.${encodeURIComponent(String(batchKey))}`;
            const response = await this.makeRequest(
                'GET',
                `/rest/v1/${this.expHistoryBatchTable}?${filter}&select=*&limit=1`
            );
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to get batch summary: ${response.status} ${text}`);
            }
            const rows = await response.json();
            return { success: true, data: rows?.[0] || null };
        } catch (error) {
            console.error('❌ expGetPlayerHistoryBatchSummary failed:', error);
            return { success: false, error: error.message };
        }
    }

    async expGetPlayerHistoryBatchJobsSnapshot({
        batchId,
        completedLimit = 40
    } = {}) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }
        if (!batchId) {
            return { success: false, error: 'batchId is required' };
        }

        const safeLimit = Math.max(1, Math.min(200, parseInt(completedLimit, 10) || 40));
        const fields = 'id,dtb_id,player_name,source_rank,status,matches_scraped,last_sync_mode,last_started_at,last_finished_at,last_error_message';

        try {
            const [runningResponse, completedResponse] = await Promise.all([
                this.makeRequest(
                    'GET',
                    `/rest/v1/${this.expHistoryJobTable}?batch_id=eq.${encodeURIComponent(batchId)}&status=eq.running&order=last_started_at.desc.nullslast,id.desc&limit=1&select=${fields}`
                ),
                this.makeRequest(
                    'GET',
                    `/rest/v1/${this.expHistoryJobTable}?batch_id=eq.${encodeURIComponent(batchId)}&status=eq.completed&order=last_finished_at.desc.nullslast,source_rank.asc.nullslast,id.asc&limit=${safeLimit}&select=${fields}`
                )
            ]);

            if (!runningResponse.ok) {
                const text = await runningResponse.text();
                throw new Error(`Failed to load running job: ${runningResponse.status} ${text}`);
            }
            if (!completedResponse.ok) {
                const text = await completedResponse.text();
                throw new Error(`Failed to load completed jobs: ${completedResponse.status} ${text}`);
            }

            const [runningRows, completedRows] = await Promise.all([
                runningResponse.json(),
                completedResponse.json()
            ]);

            return {
                success: true,
                data: {
                    running: Array.isArray(runningRows) ? (runningRows[0] || null) : null,
                    completed: Array.isArray(completedRows) ? completedRows : [],
                    completedLimit: safeLimit
                }
            };
        } catch (error) {
            console.error('❌ expGetPlayerHistoryBatchJobsSnapshot failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Save tournament metadata (upsert by event_id)
     */
    async saveTournament(tournament) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, error: 'User not authenticated' };
            }

            if (!tournament || !tournament.id) {
                return { success: false, error: 'Tournament ID is required' };
            }

            const payload = {
                event_id: String(tournament.id),
                name: tournament.name || 'Unnamed Tournament',
                start_date: tournament.startDate || new Date().toISOString(),
                end_date: tournament.endDate || new Date().toISOString(),
                registration_deadline: tournament.registrationDeadline || null,
                is_dtb_tournament: !!tournament.isDtbTournament,
                is_lk_tournament: !!tournament.isLkTournament,
                google_maps_link: tournament.googleMapsLink || null,
                url: tournament.url || null,
                updated_at: new Date().toISOString()
            };

            if (tournament.location) {
                payload.location = JSON.stringify(tournament.location);
            }

            const response = await this.makeRequest(
                'POST',
                '/rest/v1/tournaments?on_conflict=event_id',
                [payload],
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to save tournament: ${errorText}`);
            }

            return { success: true, data: payload };
        } catch (error) {
            console.error('❌ Error saving tournament:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Save Zulassungsliste for a category as a full replacement of registrations.
     */
    async saveZulassungslisteData({
        tournamentId,
        sourceCategoryId,
        sourceCategorySlug,
        sourceStatus,
        categoryName,
        players
    }) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, error: 'User not authenticated' };
            }

            if (!tournamentId || !sourceCategoryId || !categoryName || !Array.isArray(players)) {
                return { success: false, error: 'Invalid Zulassungsliste payload' };
            }

            const eventId = encodeURIComponent(String(tournamentId));
            const categoryNameClean = String(categoryName).split('(')[0].trim();

            const tournamentLookup = await this.makeRequest(
                'GET',
                `/rest/v1/tournaments?select=id&event_id=eq.${eventId}&limit=1`
            );

            if (!tournamentLookup.ok) {
                const text = await tournamentLookup.text();
                throw new Error(`Tournament lookup failed: ${text}`);
            }

            const tournamentRows = await tournamentLookup.json();
            if (!tournamentRows || tournamentRows.length === 0) {
                throw new Error(`Tournament with event_id ${tournamentId} not found`);
            }

            const tournamentUuid = tournamentRows[0].id;

            const categoryPayload = {
                tournament_id: tournamentUuid,
                source_category_id: String(sourceCategoryId),
                source_category_slug: sourceCategorySlug ? String(sourceCategorySlug) : null,
                source_status: sourceStatus ? String(sourceStatus) : null,
                category_name: categoryNameClean,
                gender: this.extractGenderFromCategory(categoryNameClean),
                age_group: this.extractAgeGroupFromCategory(categoryNameClean),
                type: 'singles',
                last_updated: new Date().toISOString()
            };

            const authToken = this.session?.access_token || this.supabaseKey;
            const categoryResponse = await fetch(
                `${this.supabaseUrl}/rest/v1/tournament_categories?on_conflict=tournament_id,source_category_id`,
                {
                    method: 'POST',
                    headers: {
                        'apikey': this.supabaseKey,
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates,return=representation'
                    },
                    body: JSON.stringify([categoryPayload])
                }
            );

            if (!categoryResponse.ok) {
                const text = await categoryResponse.text();
                throw new Error(`Category save failed: ${text}`);
            }

            const categoryRows = await categoryResponse.json();
            const category = categoryRows && categoryRows[0];
            if (!category || !category.id) {
                throw new Error('Category save returned no category id');
            }

            const deleteExisting = await this.makeRequest(
                'DELETE',
                `/rest/v1/tournament_registrations?category_id=eq.${encodeURIComponent(category.id)}`
            );
            if (!deleteExisting.ok) {
                const text = await deleteExisting.text();
                throw new Error(`Failed to clear existing registrations: ${text}`);
            }

            const cleanedPlayers = players
                .filter((player) => {
                    if (!player || !player.name || !player.name.trim() || player.name.trim() === '-') {
                        return false;
                    }
                    if (player.isPlaceholder) {
                        return false;
                    }
                    return true;
                })
                .map((player) => ({
                    // Keep DTB IDs numeric and normalized before writing to bigint columns.
                    dtb_id: this.parseDtbIdText(player.dtbId ?? player.dtbIdText ?? ''),
                    category_id: category.id,
                    player_name: player.name.trim(),
                    club_name: (player.club || '').trim(),
                    lk_rating: (player.lk || '').trim(),
                    lk_rating_numeric: player.lkNumeric || null,
                    dtb_ranking: player.dtbRanking || null,
                    position: Number.isInteger(player.position) ? player.position : null,
                    seed_number: player.seedNumber || null,
                    is_seeded: !!player.isSeeded,
                    registration_status: this.canonicalizeRegistrationStatus(player.registrationStatus),
                    section_name: player.sectionName || null
                }));

            const unique = [];
            const seen = new Set();
            for (const registration of cleanedPlayers) {
                const dedupeKey = registration.dtb_id
                    ? `dtb:${registration.dtb_id}`
                    : `nameclub:${registration.player_name}|${registration.club_name}`;
                if (seen.has(dedupeKey)) {
                    continue;
                }
                seen.add(dedupeKey);
                unique.push(registration);
            }

            if (unique.length === 0) {
                return { success: true, count: 0 };
            }

            const batchSize = 100;
            let saved = 0;

            for (let i = 0; i < unique.length; i += batchSize) {
                const batch = unique.slice(i, i + batchSize);
                const response = await this.makeRequest(
                    'POST',
                    '/rest/v1/tournament_registrations?on_conflict=category_id,player_name,club_name',
                    batch
                );

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`Failed to save registration batch: ${text}`);
                }

                saved += batch.length;
            }

            return { success: true, count: saved };
        } catch (error) {
            console.error('❌ Error saving Zulassungsliste data:', error);
            return { success: false, error: error.message };
        }
    }

    extractGenderFromCategory(categoryName) {
        if (!categoryName) return null;
        if (categoryName.includes('Herren') || categoryName.includes('HE') || categoryName.startsWith('M')) return 'M';
        if (categoryName.includes('Damen') || categoryName.includes('DE') || categoryName.startsWith('D')) return 'F';
        if (categoryName.includes('Mixed') || categoryName.includes('MX')) return 'Mixed';

        const genderMatch = categoryName.match(/^([MDF])/i);
        if (!genderMatch) return null;

        const letter = genderMatch[1].toUpperCase();
        if (letter === 'M') return 'M';
        if (letter === 'D' || letter === 'F') return 'F';
        return null;
    }

    extractAgeGroupFromCategory(categoryName) {
        if (!categoryName) return null;
        const ageMatch = categoryName.match(/(U|H|D|M|Ü|O)(\d+)/i);
        if (ageMatch) return ageMatch[0];

        const numberMatch = categoryName.match(/(\d{2,3})/);
        if (!numberMatch) return null;

        const num = parseInt(numberMatch[1], 10);
        if (num >= 8 && num <= 99) {
            return numberMatch[1];
        }
        return null;
    }

    canonicalizeRegistrationStatus(status) {
        const value = String(status || '').toLowerCase();
        if (value.includes('nachr') || value === 'nachruecker') return 'nachrücker';
        if (value.includes('quali')) return 'qualifikation';
        return 'main_draw';
    }

    normalizeClubText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    extractClubIdFromText(value) {
        const text = this.normalizeClubText(value);
        if (!text) return null;
        const match = text.match(/\((\d{4,8})\)\s*$/);
        return match ? match[1] : null;
    }

    stripClubIdSuffix(value) {
        const text = this.normalizeClubText(value);
        if (!text) return null;
        return this.normalizeClubText(text.replace(/\s*\(\d{4,8}\)\s*$/, '')) || null;
    }

    extractTeamNumber(label) {
        const text = this.normalizeClubText(label);
        if (!text) return null;
        const romanMatch = text.match(/\b([IVX]{1,6})\b$/i);
        if (romanMatch) {
            const roman = romanMatch[1].toUpperCase();
            const values = { I: 1, V: 5, X: 10 };
            let total = 0;
            for (let i = 0; i < roman.length; i++) {
                const curr = values[roman[i]] || 0;
                const next = values[roman[i + 1]] || 0;
                if (curr < next) total -= curr;
                else total += curr;
            }
            return total || 1;
        }

        // Arabic suffix can represent an explicit team ordinal in some formats (e.g. "Herren 2").
        // Values >10 are usually age classes (e.g. 18/40/50/60), so we keep those as base team 1.
        const trailingArabic = text.match(/\b(\d{1,2})\b$/);
        if (trailingArabic) {
            const trailing = parseInt(trailingArabic[1], 10);
            if (Number.isInteger(trailing) && trailing >= 1 && trailing <= 10) {
                return trailing;
            }
        }

        // Base team label without explicit ordinal (e.g. "Herren", "Damen", "Junioren 18").
        return 1;
    }

    parseSeason(value) {
        const text = this.normalizeClubText(value);
        const yearMatch = text.match(/\b(20\d{2})\b/);
        const type = text.toLowerCase().includes('winter')
            ? 'Winter'
            : text.toLowerCase().includes('sommer')
                ? 'Sommer'
                : null;
        return {
            season_year: yearMatch ? parseInt(yearMatch[1], 10) : null,
            season_type: type
        };
    }

    parseLkNumeric(value) {
        const text = this.normalizeClubText(value).replace(/^LK/i, '').replace(',', '.');
        if (!text) return null;
        const parsed = parseFloat(text);
        return Number.isNaN(parsed) ? null : parsed;
    }

    parseDtbIdText(value) {
        const match = String(value || '').match(/(\d{5,12})/);
        return match ? parseInt(match[1], 10) : null;
    }

    normalizeLeagueText(value) {
        return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    }

    stripTrailingTeamOrdinal(value) {
        const text = this.normalizeLeagueText(value);
        if (!text) return '';

        // Common team suffixes in league PDFs: "... II", "... III", "... IV", etc.
        const withoutRoman = text.replace(/\s+\b(?:II|III|IV|V|VI|VII|VIII|IX|X)\b$/i, '').trim();
        if (withoutRoman && withoutRoman !== text) {
            return withoutRoman;
        }

        // Arabic team ordinals: "... 2", "... 3", ... (keep larger numbers to avoid stripping years).
        const arabicMatch = text.match(/^(.*)\s+(\d{1,2})$/);
        if (arabicMatch) {
            const ordinal = parseInt(arabicMatch[2], 10);
            if (Number.isInteger(ordinal) && ordinal >= 2 && ordinal <= 10) {
                return this.normalizeLeagueText(arabicMatch[1]);
            }
        }

        return text;
    }

    deriveCanonicalClubNameFromLeagueTeamLabel(value) {
        const text = this.normalizeLeagueText(value);
        if (!text) return '';
        return this.stripTrailingTeamOrdinal(text);
    }

    extractLeagueAgeGroup(...parts) {
        const text = this.normalizeLeagueText(parts.filter(Boolean).join(' '));
        if (!text) return null;

        const uMatch = text.match(/\bU\s*([0-9]{1,2})\b/i);
        if (uMatch) return `U${uMatch[1]}`;

        const ageKeywords = /(herren|damen|junior(?:en|innen)?|knaben|mädchen|maedchen|mixed|freizeit)/i;
        const keywordAge = text.match(new RegExp(`${ageKeywords.source}\\s+(?:doppel\\s+)?([0-9]{2})\\b`, 'i'));
        if (keywordAge) return keywordAge[2];

        const openAge = text.match(/\b(?:ü|ue|o)\s*([0-9]{2})\b/i);
        if (openAge) return openAge[1];

        return null;
    }

    parseDateToIso(value) {
        const text = this.normalizeLeagueText(value);
        if (!text) return null;
        const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
        const deMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (deMatch) return `${deMatch[3]}-${deMatch[2]}-${deMatch[1]}`;
        return null;
    }

    parseLeagueMatchTime(...candidates) {
        for (const candidate of candidates) {
            const text = this.normalizeLeagueText(candidate);
            if (!text) continue;
            const match = text.match(/\b([0-2]?\d)[:.]([0-5]\d)\b/);
            if (!match) continue;
            const hour = String(parseInt(match[1], 10)).padStart(2, '0');
            const minute = match[2];
            return `${hour}:${minute}`;
        }
        return null;
    }

    async upsertLeagueGroupFromPayload({
        federationCode,
        seasonYear,
        seasonType,
        groupCode,
        leagueName,
        competitionLabel,
        tableMatrix,
        sourceUrl,
        sourceHash,
        sourceFetchedAt,
        ingestRunId
    }) {
        const canonicalGroupCode = this.normalizeLeagueText(groupCode);
        if (!federationCode || !seasonYear || !seasonType || !canonicalGroupCode) return null;
        const inferredAgeGroup = this.extractLeagueAgeGroup(competitionLabel, leagueName);

        const payload = {
            federation_code: this.normalizeLeagueText(federationCode).toUpperCase(),
            season_year: seasonYear,
            season_type: seasonType,
            group_code: canonicalGroupCode,
            league_name: this.normalizeLeagueText(leagueName) || null,
            competition_label: this.normalizeLeagueText(competitionLabel) || null,
            age_group: inferredAgeGroup,
            table_matrix: tableMatrix || null,
            source_url: sourceUrl || null,
            source_hash: sourceHash || null,
            source_fetched_at: sourceFetchedAt || null,
            ingest_run_id: ingestRunId || null,
            updated_at: new Date().toISOString()
        };

        try {
            const endpoint = '/rest/v1/league_groups?on_conflict=federation_code,season_year,season_type,group_code';
            let attemptPayload = { ...payload };

            for (let attempt = 0; attempt < 3; attempt += 1) {
                const response = await this.makeRequest(
                    'POST',
                    endpoint,
                    [attemptPayload],
                    { prefer: 'resolution=merge-duplicates,return=representation' }
                );
                if (response.ok) {
                    const rows = await response.json();
                    return rows?.[0] || null;
                }

                const errorText = await response.text();
                const missingAgeGroup = /column .*age_group.* does not exist/i.test(errorText);
                const missingTableMatrix = /column .*table_matrix.* does not exist/i.test(errorText);

                if (!missingAgeGroup && !missingTableMatrix) {
                    throw new Error(errorText);
                }

                if (missingAgeGroup) delete attemptPayload.age_group;
                if (missingTableMatrix) delete attemptPayload.table_matrix;
            }

            return null;
        } catch (error) {
            console.warn('⚠️ League group upsert failed:', error.message);
            return null;
        }
    }

    async findClubIdByName(name) {
        const canonical = this.normalizeLeagueText(name);
        if (!canonical) return null;
        const canonicalWithoutOrdinal = this.stripTrailingTeamOrdinal(canonical);

        try {
            const candidates = [canonical];
            if (canonicalWithoutOrdinal && canonicalWithoutOrdinal !== canonical) {
                candidates.push(canonicalWithoutOrdinal);
            }

            for (const candidate of candidates) {
                const response = await this.makeRequest(
                    'GET',
                    `/rest/v1/clubs?select=id,name&name=ilike.${encodeURIComponent(candidate)}&limit=1`
                );
                if (!response.ok) continue;
                const rows = await response.json();
                if (rows?.[0]?.id) return rows[0].id;
            }

            return null;
        } catch (_error) {
            return null;
        }
    }

    async upsertLeagueGroupTeamFromPayload({
        leagueGroupId,
        clubId,
        clubTeamId,
        teamLabel,
        rank,
        pointsText,
        matchesText,
        setsText,
        joinConfidence,
        rawTeamText
    }) {
        if (!leagueGroupId) return null;

        const payload = {
            league_group_id: leagueGroupId,
            club_id: clubId || null,
            club_team_id: clubTeamId || null,
            team_label: this.normalizeLeagueText(teamLabel) || null,
            rank: Number.isInteger(rank) ? rank : null,
            points_text: this.normalizeLeagueText(pointsText) || null,
            matches_text: this.normalizeLeagueText(matchesText) || null,
            sets_text: this.normalizeLeagueText(setsText) || null,
            join_confidence: this.normalizeLeagueText(joinConfidence) || null,
            raw_team_text: this.normalizeLeagueText(rawTeamText) || null,
            updated_at: new Date().toISOString()
        };

        try {
            if (payload.club_id) {
                const response = await this.makeRequest(
                    'POST',
                    '/rest/v1/league_group_teams?on_conflict=league_group_id,club_id,team_label',
                    [payload],
                    { prefer: 'resolution=merge-duplicates,return=representation' }
                );
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText);
                }
                const rows = await response.json();
                return rows?.[0] || null;
            }

            const existingResponse = await this.makeRequest(
                'GET',
                `/rest/v1/league_group_teams?select=*&league_group_id=eq.${encodeURIComponent(leagueGroupId)}&team_label=eq.${encodeURIComponent(payload.team_label || '')}&limit=1`
            );
            if (existingResponse.ok) {
                const existingRows = await existingResponse.json();
                const existing = existingRows?.[0];
                if (existing?.id) {
                    const patchResponse = await this.makeRequest(
                        'PATCH',
                        `/rest/v1/league_group_teams?id=eq.${encodeURIComponent(existing.id)}`,
                        payload,
                        { prefer: 'return=representation' }
                    );
                    if (patchResponse.ok) {
                        const patchedRows = await patchResponse.json();
                        return patchedRows?.[0] || null;
                    }
                }
            }

            const createResponse = await this.makeRequest(
                'POST',
                '/rest/v1/league_group_teams',
                [payload],
                { prefer: 'return=representation' }
            );
            if (!createResponse.ok) {
                const errorText = await createResponse.text();
                throw new Error(errorText);
            }
            const createdRows = await createResponse.json();
            return createdRows?.[0] || null;
        } catch (error) {
            console.warn('⚠️ League group team upsert failed:', error.message);
            return null;
        }
    }

    async loadLeagueGroupMembership(leagueGroupId) {
        if (!leagueGroupId) return [];
        try {
            const response = await this.makeRequest(
                'GET',
                `/rest/v1/league_group_teams?select=id,club_id,team_label,raw_team_text&league_group_id=eq.${encodeURIComponent(leagueGroupId)}`
            );
            if (!response.ok) return [];
            const rows = await response.json();
            return Array.isArray(rows) ? rows : [];
        } catch (_error) {
            return [];
        }
    }

    async resolveLeagueGroupId({ federationCode, seasonYear, seasonType, groupCode }) {
        const canonicalGroupCode = this.normalizeLeagueText(groupCode);
        if (!federationCode || !seasonYear || !seasonType || !canonicalGroupCode) return null;

        try {
            const response = await this.makeRequest(
                'GET',
                `/rest/v1/league_groups?select=id&federation_code=eq.${encodeURIComponent(this.normalizeLeagueText(federationCode).toUpperCase())}&season_year=eq.${encodeURIComponent(seasonYear)}&season_type=eq.${encodeURIComponent(seasonType)}&group_code=eq.${encodeURIComponent(canonicalGroupCode)}&limit=1`
            );
            if (!response.ok) return null;
            const rows = await response.json();
            return rows?.[0]?.id || null;
        } catch (_error) {
            return null;
        }
    }

    async findExistingLeagueFixtureId({
        leagueGroupId,
        matchDate,
        matchTime,
        homeTeamLabel,
        awayTeamLabel
    }) {
        if (!leagueGroupId || !matchDate) return null;

        const identity = {
            match_time: this.normalizeLeagueText(matchTime) || '',
            home_team_label: this.normalizeLeagueText(homeTeamLabel) || '',
            away_team_label: this.normalizeLeagueText(awayTeamLabel) || ''
        };

        try {
            const response = await this.makeRequest(
                'GET',
                `/rest/v1/league_fixtures?select=id,match_time,home_team_label,away_team_label&league_group_id=eq.${encodeURIComponent(leagueGroupId)}&match_date=eq.${encodeURIComponent(matchDate)}&limit=200`
            );
            if (!response.ok) return null;
            const rows = await response.json();
            if (!Array.isArray(rows) || rows.length === 0) return null;

            const existing = rows.find((row) => (
                (this.normalizeLeagueText(row?.match_time) || '') === identity.match_time
                && (this.normalizeLeagueText(row?.home_team_label) || '') === identity.home_team_label
                && (this.normalizeLeagueText(row?.away_team_label) || '') === identity.away_team_label
            ));
            if (existing?.id) return existing.id;

            // Recovery path: allow upgrading rows that were saved with empty match_time.
            if (identity.match_time) {
                const withoutTime = rows.find((row) => (
                    !(this.normalizeLeagueText(row?.match_time) || '')
                    && (this.normalizeLeagueText(row?.home_team_label) || '') === identity.home_team_label
                    && (this.normalizeLeagueText(row?.away_team_label) || '') === identity.away_team_label
                ));
                if (withoutTime?.id) return withoutTime.id;
            }
            return null;
        } catch (_error) {
            return null;
        }
    }

    async upsertLeagueFixtureFromPayload({
        leagueGroupId,
        matchDate,
        matchTime,
        homeClubId,
        awayClubId,
        homeTeamLabel,
        awayTeamLabel,
        isHomeForMainClub,
        status,
        resultText,
        sourceUrl,
        sourceHash,
        sourceFetchedAt,
        ingestRunId,
        parsedFrom
    }) {
        if (!leagueGroupId || !matchDate) return null;

        const payload = {
            league_group_id: leagueGroupId,
            match_date: matchDate,
            // Keep identity fields non-null so DB conflict target can dedupe reliably.
            match_time: this.normalizeLeagueText(matchTime) || '',
            home_club_id: homeClubId || null,
            away_club_id: awayClubId || null,
            home_team_label: this.normalizeLeagueText(homeTeamLabel) || '',
            away_team_label: this.normalizeLeagueText(awayTeamLabel) || '',
            is_home_for_main_club: typeof isHomeForMainClub === 'boolean' ? isHomeForMainClub : null,
            status: this.normalizeLeagueText(status) || 'unknown',
            result_text: this.normalizeLeagueText(resultText) || null,
            source_url: sourceUrl || null,
            source_hash: sourceHash || null,
            source_fetched_at: sourceFetchedAt || null,
            ingest_run_id: ingestRunId || null,
            parsed_from: this.normalizeLeagueText(parsedFrom) || null,
            updated_at: new Date().toISOString()
        };

        try {
            const existingId = await this.findExistingLeagueFixtureId({
                leagueGroupId,
                matchDate,
                matchTime: payload.match_time,
                homeTeamLabel: payload.home_team_label,
                awayTeamLabel: payload.away_team_label
            });
            if (existingId) {
                const patchResponse = await this.makeRequest(
                    'PATCH',
                    `/rest/v1/league_fixtures?id=eq.${encodeURIComponent(existingId)}`,
                    payload,
                    { prefer: 'return=representation' }
                );
                if (patchResponse.ok) {
                    const patchedRows = await patchResponse.json();
                    return patchedRows?.[0] || null;
                }
            }

            const response = await this.makeRequest(
                'POST',
                '/rest/v1/league_fixtures?on_conflict=league_group_id,match_date,match_time,home_team_label,away_team_label',
                [payload],
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText);
            }
            const rows = await response.json();
            return rows?.[0] || null;
        } catch (error) {
            console.warn('⚠️ League fixture upsert failed:', error.message);
            return null;
        }
    }

    async upsertClubFromPayload({ sourceClubId, name }) {
        const clubName = this.normalizeClubText(name);
        const canonicalSourceId = sourceClubId ? String(sourceClubId).trim() : null;
        if (!canonicalSourceId || !clubName) return null;

        try {
            const payload = {
                source_club_id: canonicalSourceId,
                name: clubName,
                last_seen_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            const response = await this.makeRequest(
                'POST',
                '/rest/v1/clubs?on_conflict=source_club_id',
                [payload],
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.warn('⚠️ Club upsert failed (continuing without main_club_id):', errorText);
                return null;
            }

            const rows = await response.json();
            return rows?.[0]?.id || null;
        } catch (error) {
            console.warn('⚠️ Club upsert failed (continuing without main_club_id):', error.message);
            return null;
        }
    }

    async upsertClubTeamFromPayload({
        sourceTeamId,
        clubId,
        seasonYear,
        seasonType,
        teamLabel,
        sourceUrl
    }) {
        const payload = {
            source_team_id: sourceTeamId ? String(sourceTeamId).trim() : null,
            club_id: clubId || null,
            season_year: seasonYear ?? null,
            season_type: seasonType ?? null,
            team_label: this.normalizeClubText(teamLabel) || null,
            team_number: this.extractTeamNumber(teamLabel),
            source_url: sourceUrl || null,
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        try {
            const seasonFilters = Number.isInteger(seasonYear)
                ? `&season_year=eq.${seasonYear}`
                : '&season_year=is.null';
            const seasonTypeFilter = seasonType
                ? `&season_type=eq.${encodeURIComponent(seasonType)}`
                : '&season_type=is.null';

            if (payload.source_team_id) {
                const existingBySourceResponse = await this.makeRequest(
                    'GET',
                    `/rest/v1/club_teams?source_team_id=eq.${encodeURIComponent(payload.source_team_id)}&select=*&limit=1`
                );
                if (existingBySourceResponse.ok) {
                    const existingRows = await existingBySourceResponse.json();
                    const existing = existingRows?.[0];
                    if (existing?.id) {
                        const mergedPayload = {
                            ...payload,
                            season_year: payload.season_year ?? existing.season_year ?? null,
                            season_type: payload.season_type ?? existing.season_type ?? null,
                            team_label: payload.team_label || existing.team_label || null,
                            team_number: payload.team_number ?? existing.team_number ?? null,
                            source_url: payload.source_url || existing.source_url || null
                        };

                        const patchResponse = await this.makeRequest(
                            'PATCH',
                            `/rest/v1/club_teams?id=eq.${encodeURIComponent(existing.id)}`,
                            mergedPayload,
                            { prefer: 'return=representation' }
                        );
                        if (!patchResponse.ok) {
                            const errorText = await patchResponse.text();
                            throw new Error(errorText);
                        }
                        const patchedRows = await patchResponse.json();
                        return patchedRows?.[0] || null;
                    }
                }

                // Prefer attaching source_team_id to an existing season row created from PDF ingest.
                let naturalQuery = `/rest/v1/club_teams?select=*&club_id=eq.${encodeURIComponent(clubId)}${seasonFilters}${seasonTypeFilter}&source_team_id=is.null`;
                if (payload.team_label) {
                    naturalQuery += `&team_label=eq.${encodeURIComponent(payload.team_label)}`;
                } else if (Number.isInteger(payload.team_number)) {
                    naturalQuery += `&team_number=eq.${payload.team_number}`;
                }
                naturalQuery += '&order=updated_at.desc&limit=1';

                const naturalResponse = await this.makeRequest('GET', naturalQuery);
                if (naturalResponse.ok) {
                    const naturalRows = await naturalResponse.json();
                    const natural = naturalRows?.[0];
                    if (natural?.id) {
                        const mergedPayload = {
                            ...payload,
                            season_year: payload.season_year ?? natural.season_year ?? null,
                            season_type: payload.season_type ?? natural.season_type ?? null,
                            team_label: payload.team_label || natural.team_label || null,
                            team_number: payload.team_number ?? natural.team_number ?? null,
                            source_url: payload.source_url || natural.source_url || null
                        };

                        const patchNaturalResponse = await this.makeRequest(
                            'PATCH',
                            `/rest/v1/club_teams?id=eq.${encodeURIComponent(natural.id)}`,
                            mergedPayload,
                            { prefer: 'return=representation' }
                        );
                        if (!patchNaturalResponse.ok) {
                            const errorText = await patchNaturalResponse.text();
                            throw new Error(errorText);
                        }
                        const patchedRows = await patchNaturalResponse.json();
                        return patchedRows?.[0] || null;
                    }
                }

                // Fallback to label match in same club/season context.
                if (payload.team_label) {
                    const labelQuery = `/rest/v1/club_teams?select=*&club_id=eq.${encodeURIComponent(clubId)}${seasonFilters}${seasonTypeFilter}&source_team_id=is.null&team_label=eq.${encodeURIComponent(payload.team_label)}&order=updated_at.desc&limit=1`;
                    const labelResponse = await this.makeRequest('GET', labelQuery);
                    if (labelResponse.ok) {
                        const labelRows = await labelResponse.json();
                        const labelMatch = labelRows?.[0];
                        if (labelMatch?.id) {
                            const mergedPayload = {
                                ...payload,
                                season_year: payload.season_year ?? labelMatch.season_year ?? null,
                                season_type: payload.season_type ?? labelMatch.season_type ?? null,
                                team_label: payload.team_label || labelMatch.team_label || null,
                                team_number: payload.team_number ?? labelMatch.team_number ?? null,
                                source_url: payload.source_url || labelMatch.source_url || null
                            };
                            const patchLabelResponse = await this.makeRequest(
                                'PATCH',
                                `/rest/v1/club_teams?id=eq.${encodeURIComponent(labelMatch.id)}`,
                                mergedPayload,
                                { prefer: 'return=representation' }
                            );
                            if (!patchLabelResponse.ok) {
                                const errorText = await patchLabelResponse.text();
                                throw new Error(errorText);
                            }
                            const patchedRows = await patchLabelResponse.json();
                            return patchedRows?.[0] || null;
                        }
                    }
                }

                const response = await this.makeRequest(
                    'POST',
                    '/rest/v1/club_teams',
                    [payload],
                    { prefer: 'return=representation' }
                );
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText);
                }
                const rows = await response.json();
                return rows?.[0] || null;
            }

            let existingQuery = `/rest/v1/club_teams?select=id&club_id=eq.${encodeURIComponent(clubId)}${seasonFilters}${seasonTypeFilter}`;
            if (payload.team_label) {
                existingQuery += `&team_label=eq.${encodeURIComponent(payload.team_label)}`;
            } else if (Number.isInteger(payload.team_number)) {
                existingQuery += `&team_number=eq.${payload.team_number}`;
            }
            existingQuery += '&limit=1';
            const existingResponse = await this.makeRequest('GET', existingQuery);

            if (existingResponse.ok) {
                const rows = await existingResponse.json();
                if (rows?.[0]?.id) {
                    const patchResponse = await this.makeRequest(
                        'PATCH',
                        `/rest/v1/club_teams?id=eq.${encodeURIComponent(rows[0].id)}`,
                        payload,
                        { prefer: 'return=representation' }
                    );
                    if (patchResponse.ok) {
                        const patchedRows = await patchResponse.json();
                        return patchedRows?.[0] || null;
                    }
                }
            }

            const createResponse = await this.makeRequest(
                'POST',
                '/rest/v1/club_teams',
                [payload],
                { prefer: 'return=representation' }
            );
            if (!createResponse.ok) {
                const errorText = await createResponse.text();
                const refetchResponse = await this.makeRequest('GET', existingQuery);
                if (refetchResponse.ok) {
                    const existingRows = await refetchResponse.json();
                    if (existingRows?.[0]?.id) {
                        return existingRows[0];
                    }
                }
                throw new Error(errorText);
            }
            const createdRows = await createResponse.json();
            return createdRows?.[0] || null;
        } catch (error) {
            console.warn('⚠️ Club team upsert failed (continuing):', error.message);
            return null;
        }
    }

    async syncTeamPlayersIntoCanonicalPlayers(players, canonicalClubName = null, canonicalClubId = null) {
        const nowIso = new Date().toISOString();
        const normalizedClubName = this.normalizeClubText(canonicalClubName) || null;
        const normalizedClubId = canonicalClubId || null;
        const cleaned = Array.isArray(players)
            ? players
                .map((player) => ({
                    dtb_id: player?.observed_player_dtb_id || null,
                    full_name: this.normalizeClubText(player?.observed_player_name),
                    leistungsklasse: this.parseLkNumeric(player?.lk_numeric),
                    nationality: this.normalizeClubText(player?.nationality),
                    club: normalizedClubName,
                    main_club_id: normalizedClubId
                }))
                .filter((player) => Number.isInteger(player.dtb_id) && player.full_name)
            : [];

        if (cleaned.length === 0) {
            return new Map();
        }

        const dedupedByDtb = new Map();
        for (const player of cleaned) {
            const existing = dedupedByDtb.get(player.dtb_id);
            if (!existing) {
                dedupedByDtb.set(player.dtb_id, player);
                continue;
            }

            dedupedByDtb.set(player.dtb_id, {
                dtb_id: player.dtb_id,
                full_name: existing.full_name || player.full_name,
                leistungsklasse: existing.leistungsklasse ?? player.leistungsklasse ?? null,
                nationality: existing.nationality || player.nationality || null,
                club: existing.club || player.club || null,
                main_club_id: existing.main_club_id || player.main_club_id || null
            });
        }

        const dtbIds = Array.from(dedupedByDtb.keys());
        const existingByDtb = new Map();
        if (dtbIds.length > 0) {
            const inList = dtbIds.join(',');
            const existingResponse = await this.makeRequest(
                'GET',
                `/rest/v1/players?dtb_id=in.(${encodeURIComponent(inList)})&select=id,dtb_id,full_name,leistungsklasse,nationality,club,main_club_id,profile_url`
            );
            if (!existingResponse.ok) {
                const errorText = await existingResponse.text();
                throw new Error(`Failed to fetch existing players: ${errorText}`);
            }
            const existingRows = await existingResponse.json();
            for (const row of Array.isArray(existingRows) ? existingRows : []) {
                if (Number.isInteger(row?.dtb_id)) {
                    existingByDtb.set(row.dtb_id, row);
                }
            }
        }

        const upsertRows = dtbIds.map((dtbId) => {
            const incoming = dedupedByDtb.get(dtbId);
            const existing = existingByDtb.get(dtbId) || null;
            const hasProfileSource = Boolean(existing?.profile_url);
            const resolvedName = hasProfileSource
                ? (existing?.full_name || incoming.full_name)
                : (incoming.full_name || existing?.full_name);

            // Team LK should only seed/fill missing values; profile LK is the source of truth.
            const resolvedLk = hasProfileSource && existing?.leistungsklasse != null
                ? existing.leistungsklasse
                : (existing?.leistungsklasse ?? incoming.leistungsklasse ?? null);

            const resolvedNationality = existing?.nationality || incoming.nationality || null;
            const resolvedClub = hasProfileSource
                ? (existing?.club || incoming.club || null)
                : (incoming.club || existing?.club || null);
            const resolvedMainClubId = hasProfileSource
                ? (existing?.main_club_id || incoming.main_club_id || null)
                : (incoming.main_club_id || existing?.main_club_id || null);

            return {
                dtb_id: dtbId,
                full_name: resolvedName,
                leistungsklasse: resolvedLk,
                nationality: resolvedNationality,
                club: resolvedClub,
                main_club_id: resolvedMainClubId,
                updated_at: nowIso
            };
        });

        if (upsertRows.length > 0) {
            const upsertResponse = await this.makeRequest(
                'POST',
                '/rest/v1/players?on_conflict=dtb_id',
                upsertRows,
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );
            if (!upsertResponse.ok) {
                const errorText = await upsertResponse.text();
                throw new Error(`Failed to upsert team players into players: ${errorText}`);
            }
        }

        const refetchInList = dtbIds.join(',');
        const refetchResponse = await this.makeRequest(
            'GET',
            `/rest/v1/players?dtb_id=in.(${encodeURIComponent(refetchInList)})&select=id,dtb_id`
        );
        if (!refetchResponse.ok) {
            const errorText = await refetchResponse.text();
            throw new Error(`Failed to refetch canonical players: ${errorText}`);
        }

        const canonicalRows = await refetchResponse.json();
        const playerIdByDtb = new Map();
        for (const row of Array.isArray(canonicalRows) ? canonicalRows : []) {
            if (Number.isInteger(row?.dtb_id) && row?.id) {
                playerIdByDtb.set(row.dtb_id, row.id);
            }
        }

        return playerIdByDtb;
    }

    // -----------------------------------------------------------------------
    // URL Scraper: lightweight player URL upsert
    // -----------------------------------------------------------------------

    async getPlayersWithUrls(dtbIds) {
        if (!Array.isArray(dtbIds) || dtbIds.length === 0) return [];
        const inList = dtbIds.join(',');
        const response = await this.makeRequest(
            'GET',
            `/rest/v1/players?dtb_id=in.(${encodeURIComponent(inList)})&select=dtb_id,profile_url`
        );
        if (!response.ok) return [];
        const rows = await response.json();
        return Array.isArray(rows) ? rows : [];
    }

    async batchUpsertPlayerUrls(players) {
        // players: [{ dtb_id, full_name, profile_url }]
        if (!Array.isArray(players) || players.length === 0) return { success: true, count: 0 };

        const nowIso = new Date().toISOString();
        const rows = players.map((p) => ({
            dtb_id: p.dtb_id,
            full_name: p.full_name,
            profile_url: p.profile_url,
            updated_at: nowIso
        }));

        const response = await this.makeRequest(
            'POST',
            '/rest/v1/players?on_conflict=dtb_id',
            rows,
            { prefer: 'resolution=merge-duplicates,return=representation' }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to upsert player URLs: ${errorText}`);
        }

        return { success: true, count: rows.length };
    }

    async saveClubTeamPortraitData(payload) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, error: 'User not authenticated' };
            }

            const club = payload?.club || {};
            const team = payload?.team || {};
            const players = Array.isArray(payload?.players) ? payload.players : [];
            const season = payload?.season || this.parseSeason(payload?.seasonLabel);
            const resolvedSourceTeamId = this.normalizeClubText(team.sourceTeamId || payload?.route?.teamId);

            if (!club?.sourceClubId || !club?.name) {
                return { success: false, error: 'Missing club identity for team portrait payload' };
            }
            if (!resolvedSourceTeamId) {
                return { success: false, error: 'Missing source team id for team portrait payload' };
            }

            const clubId = await this.upsertClubFromPayload({
                sourceClubId: club.sourceClubId,
                name: club.name
            });
            if (!clubId) {
                return { success: false, error: 'Failed to resolve club id' };
            }

            const upsertedTeam = await this.upsertClubTeamFromPayload({
                sourceTeamId: resolvedSourceTeamId,
                clubId,
                seasonYear: season?.season_year ?? null,
                seasonType: season?.season_type ?? null,
                teamLabel: team.teamLabel || team.groupCode || null,
                sourceUrl: payload.sourceUrl || null
            });

            const cleanedPlayers = players
                .filter((player) => player && this.normalizeClubText(player.name))
                .map((player, index) => ({
                    club_id: clubId,
                    season_year: season?.season_year ?? null,
                    season_type: season?.season_type ?? null,
                    player_id: null,
                    observed_player_dtb_id: player.dtbId || this.parseDtbIdText(player.dtbIdText || '') || null,
                    observed_player_name: this.normalizeClubText(player.name),
                    overall_rank: Number.isInteger(player.rank) && player.rank > 0 ? player.rank : (index + 1),
                    lk_numeric: this.parseLkNumeric(player.lk),
                    nationality: this.normalizeClubText(player.nationality) || null,
                    observed_source_team_id: resolvedSourceTeamId,
                    observed_group_code: this.normalizeClubText(team.groupCode || team.teamLabel) || null,
                    observed_source_url: payload.sourceUrl || null,
                    parsed_from: player.parsedFrom || payload.parsedFrom || null,
                    last_seen_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }));

            if (cleanedPlayers.length === 0) {
                return { success: true, clubId, teamId: upsertedTeam?.id || null, rankingsSaved: 0 };
            }

            const canonicalPlayerIdByDtb = await this.syncTeamPlayersIntoCanonicalPlayers(
                cleanedPlayers,
                club.name,
                clubId
            );
            for (const player of cleanedPlayers) {
                if (player.observed_player_dtb_id && canonicalPlayerIdByDtb.has(player.observed_player_dtb_id)) {
                    player.player_id = canonicalPlayerIdByDtb.get(player.observed_player_dtb_id);
                }
            }

            const rankingsResponse = await this.makeRequest(
                'POST',
                '/rest/v1/club_player_rankings?on_conflict=club_id,season_year,season_type,observed_source_team_id,observed_player_name',
                cleanedPlayers,
                { prefer: 'resolution=merge-duplicates,return=representation' }
            );
            if (!rankingsResponse.ok) {
                const errorText = await rankingsResponse.text();
                throw new Error(`Ranking upsert failed: ${errorText}`);
            }
            const rankingsRows = await rankingsResponse.json();

            return {
                success: true,
                clubId,
                teamId: upsertedTeam?.id || null,
                rankingsSaved: Array.isArray(rankingsRows) ? rankingsRows.length : cleanedPlayers.length
            };
        } catch (error) {
            console.error('❌ Error saving club team portrait data:', error);
            return { success: false, error: error.message };
        }
    }

    async saveClubLeagueTablesData(payload) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, error: 'User not authenticated' };
            }

            const ingestRunId = `league-tables-${Date.now()}`;
            const sourceUrl = payload?.sourceUrl || payload?.source_url || null;
            const sourceHash = payload?.sourceHash || payload?.source_hash || null;
            const sourceFetchedAt = payload?.sourceFetchedAt || payload?.source_fetched_at || new Date().toISOString();

            let parsed = payload;
            if ((!Array.isArray(parsed?.groups) || parsed.groups.length === 0) && payload?.pdf_text_available && payload?.pdf_text) {
                if (typeof LeagueParsers !== 'undefined' && LeagueParsers.parseLeagueTablesPdfText) {
                    parsed = LeagueParsers.parseLeagueTablesPdfText(payload.pdf_text, {
                        federation_code: payload?.federation_code || null,
                        source_club_id: payload?.source_club_id || null,
                        source_url: sourceUrl
                    });
                }
            }

            let federationCode = this.normalizeLeagueText(parsed?.federation_code || payload?.federation_code).toUpperCase();
            const sourceClubId = this.normalizeLeagueText(parsed?.source_club_id || payload?.source_club_id);
            const seasonYear = parsed?.season_year ?? payload?.season_year ?? null;
            const seasonType = this.normalizeLeagueText(parsed?.season_type || payload?.season_type) || null;
            const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
            const parsedTeamsCount = groups.reduce(
                (sum, group) => sum + (Array.isArray(group?.teams) ? group.teams.length : 0),
                0
            );

            if (!federationCode && typeof LeagueParsers !== 'undefined' && LeagueParsers.inferFederationFromPdfText) {
                federationCode = LeagueParsers.inferFederationFromPdfText(payload?.pdf_text || '') || '';
            }
            const missingIdentityFields = [
                !federationCode ? 'federation_code' : null,
                !seasonYear ? 'season_year' : null,
                !seasonType ? 'season_type' : null
            ].filter(Boolean);
            const hasRequiredIdentity = missingIdentityFields.length === 0;

            let groupsSaved = 0;
            let membershipsSaved = 0;

            if (groups.length === 0 || parsedTeamsCount === 0) {
                try {
                    const key = `leagueTablesRaw:${Date.now()}`;
                    await chrome.storage.local.set({
                        [key]: {
                            ingestRunId,
                            sourceUrl,
                            sourceHash,
                            sourceFetchedAt,
                            payload: payload || null
                        }
                    });
                } catch (_error) {
                    // Non-blocking fallback.
                }
                return {
                    success: true,
                    stagedOnly: true,
                    groupsSaved: 0,
                    membershipsSaved: 0,
                    warning: groups.length === 0
                        ? 'No league groups parsed from PDF payload'
                        : 'No league team rows parsed from PDF payload'
                };
            }

            if (!hasRequiredIdentity) {
                try {
                    const key = `leagueTablesRaw:${Date.now()}`;
                    await chrome.storage.local.set({
                        [key]: {
                            ingestRunId,
                            sourceUrl,
                            sourceHash,
                            sourceFetchedAt,
                            parsed: {
                                source_club_id: sourceClubId || null,
                                groups
                            },
                            missingIdentityFields
                        }
                    });
                } catch (_error) {
                    // Non-blocking fallback.
                }
                return {
                    success: true,
                    stagedOnly: true,
                    groupsSaved: 0,
                    membershipsSaved: 0,
                    warning: `Missing league table identity fields: ${missingIdentityFields.join(', ')}`,
                    debug: {
                        federationCode: federationCode || null,
                        sourceClubId: sourceClubId || null,
                        seasonYear: seasonYear || null,
                        seasonType: seasonType || null,
                        groupsCount: groups.length
                    }
                };
            }

            for (const group of groups) {
                const groupRow = await this.upsertLeagueGroupFromPayload({
                    federationCode,
                    seasonYear,
                    seasonType,
                    groupCode: group?.group_code || null,
                    leagueName: group?.league_name || null,
                    competitionLabel: group?.competition_label || null,
                    tableMatrix: group?.table_matrix || null,
                    sourceUrl,
                    sourceHash,
                    sourceFetchedAt,
                    ingestRunId
                });

                if (!groupRow?.id) continue;
                groupsSaved += 1;

                const teams = Array.isArray(group?.teams) ? group.teams : [];
                for (const team of teams) {
                    const teamSourceClubId = this.normalizeLeagueText(team?.source_club_id || '');
                    const teamLabel = this.normalizeLeagueText(team?.team_label || '');

                    let clubId = null;
                    let clubTeamId = null;
                    let joinConfidence = 'low';

                    if (teamSourceClubId) {
                        const canonicalClubName = this.deriveCanonicalClubNameFromLeagueTeamLabel(
                            teamLabel || team?.raw_team_text || ''
                        );
                        clubId = await this.upsertClubFromPayload({
                            sourceClubId: teamSourceClubId,
                            name: canonicalClubName || `Club ${teamSourceClubId}`
                        });
                        if (clubId) {
                            joinConfidence = 'high';
                        }
                    }

                    if (!clubId && teamLabel) {
                        clubId = await this.findClubIdByName(teamLabel);
                        if (clubId) {
                            joinConfidence = 'low';
                        }
                    }

                    if (clubId) {
                        const clubTeamRow = await this.upsertClubTeamFromPayload({
                            sourceTeamId: null,
                            clubId,
                            seasonYear,
                            seasonType,
                            teamLabel: teamLabel || null,
                            sourceUrl
                        });
                        clubTeamId = clubTeamRow?.id || null;
                    }

                    const membershipRow = await this.upsertLeagueGroupTeamFromPayload({
                        leagueGroupId: groupRow.id,
                        clubId,
                        clubTeamId,
                        teamLabel: teamLabel || null,
                        rank: Number.isInteger(team?.rank) ? team.rank : null,
                        pointsText: team?.points_text || null,
                        matchesText: team?.matches_text || null,
                        setsText: team?.sets_text || null,
                        joinConfidence,
                        rawTeamText: team?.raw_team_text || null
                    });

                    if (membershipRow?.id) membershipsSaved += 1;
                }
            }

            return {
                success: true,
                groupsSaved,
                membershipsSaved
            };
        } catch (error) {
            console.error('❌ Error saving club league tables data:', error);
            return { success: false, error: error.message };
        }
    }

    async saveClubCalendarData(payload) {
        try {
            if (!this.isReady() || !this.isAuthenticated()) {
                return { success: false, error: 'User not authenticated' };
            }

            const sourceUrl = payload?.sourceUrl || payload?.source_url || null;
            const sourceHash = payload?.sourceHash || payload?.source_hash || null;
            const sourceFetchedAt = payload?.sourceFetchedAt || payload?.source_fetched_at || new Date().toISOString();
            const ingestRunId = `league-calendar-${Date.now()}`;

            const federationCode = this.normalizeLeagueText(payload?.federation_code || '').toUpperCase();
            const sourceClubId = this.normalizeLeagueText(payload?.source_club_id || '');
            const seasonYear = payload?.season_year ?? null;
            const seasonType = this.normalizeLeagueText(payload?.season_type || '') || null;
            const fixtures = Array.isArray(payload?.fixtures) ? payload.fixtures : [];
            const debug = {
                ingestRunId,
                identity: {
                    federationCode: federationCode || null,
                    sourceClubId: sourceClubId || null,
                    seasonYear: seasonYear || null,
                    seasonType: seasonType || null
                },
                totalFixtures: fixtures.length,
                fixturesSaved: 0,
                skipped: {
                    missingDate: 0,
                    missingGroupCode: 0,
                    unresolvedLeagueGroup: 0,
                    upsertFailed: 0
                },
                samples: []
            };
            const addSample = (reason, fixture, extra = {}) => {
                if (debug.samples.length >= 12) return;
                debug.samples.push({
                    reason,
                    date: fixture?.date || null,
                    group_code: fixture?.group_code || null,
                    time: fixture?.time || null,
                    opponent_team_label: fixture?.opponent_team_label || null,
                    ...extra
                });
            };

            if (!federationCode || !sourceClubId) {
                return { success: false, error: 'Missing calendar identity fields (federation/club)' };
            }

            const mainClubId = await this.upsertClubFromPayload({
                sourceClubId,
                name: `Club ${sourceClubId}`
            });

            const groupMembershipCache = new Map();
            let fixturesSaved = 0;

            for (const fixture of fixtures) {
                const parsedDate = this.parseDateToIso(fixture?.date);
                if (!parsedDate) {
                    debug.skipped.missingDate += 1;
                    addSample('missing_date', fixture);
                    continue;
                }

                const groupCode = this.normalizeLeagueText(fixture?.group_code || '');
                if (!groupCode) {
                    debug.skipped.missingGroupCode += 1;
                    addSample('missing_group_code', fixture, { parsedDate });
                    continue;
                }
                const resolvedSeasonYear = seasonYear || parseInt(parsedDate.slice(0, 4), 10);
                const resolvedSeasonType = seasonType || null;

                let leagueGroupId = null;
                if (groupCode && resolvedSeasonYear && resolvedSeasonType) {
                    leagueGroupId = await this.resolveLeagueGroupId({
                        federationCode,
                        seasonYear: resolvedSeasonYear,
                        seasonType: resolvedSeasonType,
                        groupCode
                    });
                }

                if (!leagueGroupId) {
                    debug.skipped.unresolvedLeagueGroup += 1;
                    addSample('unresolved_league_group', fixture, {
                        parsedDate,
                        resolvedSeasonYear,
                        resolvedSeasonType
                    });
                    continue;
                }

                const cacheKey = String(leagueGroupId);
                if (!groupMembershipCache.has(cacheKey)) {
                    groupMembershipCache.set(cacheKey, await this.loadLeagueGroupMembership(leagueGroupId));
                }
                const groupMembership = groupMembershipCache.get(cacheKey) || [];

                const opponentLabel = this.normalizeLeagueText(fixture?.opponent_team_label || null) || null;
                let opponentClubId = null;
                if (opponentLabel) {
                    const inGroup = groupMembership.find((row) => {
                        const a = this.normalizeLeagueText(row?.team_label || '');
                        const b = this.normalizeLeagueText(row?.raw_team_text || '');
                        return a === opponentLabel || b.includes(opponentLabel) || opponentLabel.includes(a);
                    });
                    opponentClubId = inGroup?.club_id || null;
                    if (!opponentClubId) {
                        opponentClubId = await this.findClubIdByName(opponentLabel);
                    }
                }

                const isHome = fixture?.is_home_for_main_club;
                const homeClubId = isHome === true ? mainClubId : opponentClubId;
                const awayClubId = isHome === true ? opponentClubId : mainClubId;
                const parsedMatchTime = this.parseLeagueMatchTime(
                    fixture?.time || null,
                    fixture?.raw_cell_text || null
                );

                const saved = await this.upsertLeagueFixtureFromPayload({
                    leagueGroupId,
                    matchDate: parsedDate,
                    matchTime: parsedMatchTime,
                    homeClubId,
                    awayClubId,
                    homeTeamLabel: isHome === true ? `Club ${sourceClubId}` : opponentLabel,
                    awayTeamLabel: isHome === true ? opponentLabel : `Club ${sourceClubId}`,
                    isHomeForMainClub: typeof isHome === 'boolean' ? isHome : null,
                    status: fixture?.status || 'unknown',
                    resultText: fixture?.result_text || null,
                    sourceUrl,
                    sourceHash,
                    sourceFetchedAt,
                    ingestRunId,
                    parsedFrom: 'vereinsspielplan'
                });

                if (saved?.id) {
                    fixturesSaved += 1;
                } else {
                    debug.skipped.upsertFailed += 1;
                    addSample('upsert_failed', fixture, { parsedDate, leagueGroupId });
                }
            }

            debug.fixturesSaved = fixturesSaved;
            const debugSummary = [
                `total=${debug.totalFixtures}`,
                `saved=${debug.fixturesSaved}`,
                `missingDate=${debug.skipped.missingDate}`,
                `missingGroupCode=${debug.skipped.missingGroupCode}`,
                `unresolvedLeagueGroup=${debug.skipped.unresolvedLeagueGroup}`,
                `upsertFailed=${debug.skipped.upsertFailed}`
            ].join(', ');

            try {
                await chrome.storage.local.set({
                    lastLeagueCalendarSyncDebug: {
                        at: new Date().toISOString(),
                        sourceUrl,
                        sourceHash,
                        debug
                    }
                });
            } catch (_error) {
                // Non-blocking debug persistence.
            }

            return {
                success: true,
                fixturesSaved,
                debug,
                debugSummary
            };
        } catch (error) {
            console.error('❌ Error saving club calendar data:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get match statistics for a player
     */
    async getPlayerStats(playerName) {
        if (!this.isReady()) {
            throw new Error('Supabase client not initialized');
        }

        try {
            // This would require more complex queries - simplified for now
            const response = await this.makeRequest('GET', 
                `/rest/v1/${this.matchesTable}?or=(team1_player1_name.eq.${encodeURIComponent(playerName)},team1_player2_name.eq.${encodeURIComponent(playerName)},team2_player1_name.eq.${encodeURIComponent(playerName)},team2_player2_name.eq.${encodeURIComponent(playerName)})&select=*`
            );

            if (!response.ok) {
                throw new Error(`Failed to get player stats: ${response.status}`);
            }

            const matches = await response.json();
            
            const totalMatches = matches.length;
            const wins = matches.filter((m) => {
                const inTeam1 = m.team1_player1_name === playerName || m.team1_player2_name === playerName;
                const inTeam2 = m.team2_player1_name === playerName || m.team2_player2_name === playerName;
                return (inTeam1 && m.winner_side === 1) || (inTeam2 && m.winner_side === 2);
            }).length;
            const losses = totalMatches - wins;
            const winRate = totalMatches ? Math.round((wins / totalMatches) * 100) : 0;

            return {
                totalMatches,
                wins,
                losses,
                winRate,
                recentMatches: matches.slice(0, 10)
            };

        } catch (error) {
            console.error('❌ Error getting player stats:', error);
            throw error;
        }
    }

    /**
     * Check database connection
     */
    async testConnection() {
        if (!this.isReady()) {
            return { success: false, error: 'Client not initialized' };
        }

        try {
            if (this.client) {
                // Use official Supabase client
                const { data, error, count } = await this.client
                    .from(this.matchesTable)
                    .select('id', { count: 'exact', head: true });

                if (error) {
                    return { success: false, error: error.message };
                }

                return { 
                    success: true, 
                    message: `Connected successfully. Database contains ${count || 0} matches.` 
                };
            } else {
                // Use fetch fallback - simple query without count
                const response = await this.makeRequest('GET', `/rest/v1/${this.matchesTable}?select=id&limit=1`);

                if (!response.ok) {
                    return { success: false, error: `${response.status} ${response.statusText}` };
                }

                // Just confirm connection works
                return { 
                    success: true, 
                    message: `Connected successfully. Database is accessible.` 
                };
            }

        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// Make available globally for both service workers and regular scripts
if (typeof window !== 'undefined') {
    window.SupabaseClient = SupabaseClient;
} else {
    // For service workers, make it globally available
    self.SupabaseClient = SupabaseClient;
}
