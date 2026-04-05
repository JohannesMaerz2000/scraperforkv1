// Enhanced Tennis.de Scraper content script with proper database formatting

console.log("🎾 Tennis.de Scraper content script has been injected and is active!");

// Global variables to manage state
let currentObserver = null;
let lastScrapedUrl = null;
let isCurrentlyObserving = false;

// Check if we're on a player profile page
function isPlayerProfilePage() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes('tennis.de') && url.pathname.toLowerCase().includes('/spielerprofil');
  } catch (error) {
    return window.location.href.includes('tennis.de') && window.location.href.includes('spielerprofil');
  }
}

/**
 * Normalizes and sorts players/teams for consistent hashing
 */
/**
 * Canonical string normalization for hash inputs.
 * Trims, collapses whitespace, lowercases, and applies Unicode NFC normalization
 * so that minor DOM differences (trailing spaces, different accents) don't produce
 * divergent fingerprints.
 */
function normalizeForHash(s) {
    return (s || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalizes and sorts players/teams for consistent hashing (LK-independent)
 */
function normalizePlayersForHashing(player1Name, player1LK, player2Name, player2LK, player1Partner = '', player2Partner = '', player1PartnerLK = '', player2PartnerLK = '') {
    // Create normalized player strings WITHOUT LK values for hash consistency
    // LK values can be inconsistent between scraping perspectives, so exclude them from hash
    const team1Players = [
        normalizeForHash(player1Name),
        player1Partner ? normalizeForHash(player1Partner) : null
    ].filter(Boolean);
    
    const team2Players = [
        normalizeForHash(player2Name),
        player2Partner ? normalizeForHash(player2Partner) : null
    ].filter(Boolean);

    // Sort players within each team alphabetically by name
    team1Players.sort((a, b) => a.localeCompare(b));
    team2Players.sort((a, b) => a.localeCompare(b));

    // Create team strings (names only)
    const team1String = team1Players.join(' / ');
    const team2String = team2Players.join(' / ');

    // Sort teams alphabetically to ensure consistency
    const sortedTeams = [team1String, team2String].sort();

    return {
        team1: sortedTeams[0],
        team2: sortedTeams[1],
        // Track which original team became team1/team2 for score normalization
        team1IsOriginalTeam1: sortedTeams[0] === team1String
    };
}

/**
 * Normalizes and sorts players/teams for database storage (with LK values)
 */
function normalizePlayersForDatabase(player1Name, player1LK, player2Name, player2LK, player1Partner = '', player2Partner = '', player1PartnerLK = '', player2PartnerLK = '') {
    // Create normalized player strings WITH LK values for database storage
    const team1Players = [
        { name: player1Name, lk: player1LK },
        player1Partner ? { name: player1Partner, lk: parseLKValue(player1PartnerLK) } : null
    ].filter(Boolean);
    
    const team2Players = [
        { name: player2Name, lk: player2LK },
        player2Partner ? { name: player2Partner, lk: parseLKValue(player2PartnerLK) } : null
    ].filter(Boolean);
    
    // Sort players within each team alphabetically by name
    team1Players.sort((a, b) => a.name.localeCompare(b.name));
    team2Players.sort((a, b) => a.name.localeCompare(b.name));
    
    // Create team strings with LK values
    const team1String = team1Players.map(p => 
        p.lk !== null ? `${p.name} (LK ${p.lk})` : p.name
    ).join(' / ');
    
    const team2String = team2Players.map(p => 
        p.lk !== null ? `${p.name} (LK ${p.lk})` : p.name
    ).join(' / ');
    
    // Sort teams alphabetically to ensure consistency
    const sortedTeams = [team1String, team2String].sort();
    
    return {
        team1: sortedTeams[0],
        team2: sortedTeams[1],
        // Track which original team became team1/team2 for score normalization
        team1IsOriginalTeam1: sortedTeams[0] === team1String,
        // Also return individual player data for database storage
        team1Players: sortedTeams[0] === team1String ? team1Players : team2Players,
        team2Players: sortedTeams[0] === team1String ? team2Players : team1Players
    };
}

/**
 * Normalizes score based on team sorting.
 * Always canonicalizes the retirement marker to "Aufg." (tennis.de shows "Aufg" without
 * period from the winner's perspective and "Aufg." from the loser's perspective).
 * The partial set before retirement is also flipped when teams are swapped.
 */
function normalizeScore(scoreString, team1IsOriginalTeam1) {
    if (!scoreString || scoreString.toLowerCase() === 'n.a.' || scoreString.trim() === '') {
        return scoreString;
    }

    // Detect and strip retirement marker (both "Aufg." and "Aufg" without period)
    const hasRetirement = /\bAufg\.?$/.test(scoreString.trim());
    const baseScore = scoreString.trim().replace(/\s*\bAufg\.?\s*$/, '').trim();

    let resultScore;
    if (!team1IsOriginalTeam1) {
        // Teams were swapped — flip ALL set scores including any partial retirement set
        const setMatches = baseScore.match(/(\d+):(\d+)(?:\s*\([\d:]+\))?/g);
        if (setMatches) {
            const flippedSets = setMatches.map(setScore => {
                const match = setScore.match(/(\d+):(\d+)(\s*\([\d:]+\))?/);
                if (match) {
                    // Normalize tiebreak to always have a space before "("
                    const tiebreak = match[3] ? ' ' + match[3].trim() : '';
                    return `${match[2]}:${match[1]}${tiebreak}`;
                }
                return setScore;
            });
            resultScore = flippedSets.join(' ');
        } else {
            resultScore = baseScore;
        }
    } else {
        resultScore = baseScore;
    }

    // Re-append canonical retirement marker
    if (hasRetirement) {
        resultScore = resultScore + ' Aufg.';
    }

    return resultScore;
}

/**
 * Universal match hash generation that's consistent regardless of scraping perspective
 */
function generateUniversalMatchHash(player1Name, player1LK, player2Name, player2LK, matchDate, eventName, player1Partner = '', player2Partner = '', scoreString = '', player1PartnerLK = '', player2PartnerLK = '') {
    // Normalize players and teams
    const normalized = normalizePlayersForHashing(
        player1Name, player1LK, player2Name, player2LK, 
        player1Partner, player2Partner, player1PartnerLK, player2PartnerLK
    );
    
    // Normalize the score to match team order
    const normalizedScore = normalizeScore(scoreString, normalized.team1IsOriginalTeam1);
    
    // Create the hash input string with consistent ordering.
    // All string fields are already normalized via normalizeForHash (applied to player names
    // in normalizePlayersForHashing) or normalized here for date/event.
    const hashComponents = [
        normalized.team1,
        normalized.team2,
        normalizeForHash(matchDate) || 'unknown-date',
        normalizeForHash(eventName) || 'unknown-event',
        normalizedScore || 'no-score',
    ];
    
    const hashInput = hashComponents.join('|');
    
    console.log(`🔧 Hash components for ${normalized.team1} vs ${normalized.team2}:`);
    console.log(`   Team1: "${normalized.team1}"`);
    console.log(`   Team2: "${normalized.team2}"`);
    console.log(`   Date: "${matchDate}"`);
    console.log(`   Event: "${eventName}"`);
    console.log(`   Score: "${normalizedScore}"`);
    console.log(`   Full hash input: "${hashInput}"`);
    
    // Generate hash without truncation to avoid collisions
    const fullHash = btoa(hashInput).replace(/[^a-zA-Z0-9]/g, '');
    console.log(`   Generated hash: "${fullHash}"`);
    
    return fullHash;
}

/**
 * Enhanced score parsing that handles retirements, walkovers, and match tiebreaks
 */
function parseScoreEnhanced(scoreString) {
    if (!scoreString || scoreString.trim() === '') {
        return null;
    }
    
    const cleanScore = scoreString.trim();
    
    // Handle "n.a." case
    if (cleanScore.toLowerCase() === 'n.a.') {
        return {
            type: 'not_played',
            sets: [],
            retirement: false,
            walkover: true,
            completed: false
        };
    }
    
    // Check for retirement — tennis.de shows "Aufg." (loss perspective) or "Aufg" (win perspective)
    const hasRetirement = /\bAufg\.?(\s|$)/.test(cleanScore);

    // Extract sets - handle both normal sets and retirement indicator
    const parts = cleanScore.split(/\s+/);
    const sets = [];
    let retirementInSet = null;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (part === 'Aufg.' || part === 'Aufg') {
            retirementInSet = i; // Retirement happened after this many sets
            break;
        }
        
        // Match regular set scores: "6:4", "7:6", "11:9" (match tiebreak)
        const setMatch = part.match(/^(\d+):(\d+)$/);
        if (setMatch) {
            const p1Games = parseInt(setMatch[1]);
            const p2Games = parseInt(setMatch[2]);
            
            // Determine if this is a match tiebreak (usually 10+ points)
            const isMatchTiebreak = (p1Games >= 10 || p2Games >= 10) && 
                                   Math.abs(p1Games - p2Games) <= 2;
            
            sets.push({
                p1_games: p1Games,
                p2_games: p2Games,
                is_match_tiebreak: isMatchTiebreak
            });
        }
    }
    
    // Determine match completion status
    const isCompleted = !hasRetirement && cleanScore !== 'n.a.' && sets.length >= 2;
    
    return {
        type: hasRetirement ? 'retirement' : (cleanScore === 'n.a.' ? 'not_played' : 'completed'),
        sets: sets,
        retirement: hasRetirement,
        walkover: cleanScore.toLowerCase() === 'n.a.',
        completed: isCompleted,
        retirement_after_sets: retirementInSet,
        raw_score: cleanScore
    };
}

/**
 * Parse German date format (DD.MM.YYYY) to ISO format
 */
function parseGermanDate(dateString) {
    if (!dateString || !dateString.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
        return null;
    }
    
    const [day, month, year] = dateString.split('.');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse LK value from string (e.g., "LK 21,6" -> 21.6)
 */
function parseLKValue(lkString) {
    if (!lkString) return null;
    
    // Remove "LK" prefix and any parentheses
    const cleanLK = lkString.replace(/LK\s*/i, '').replace(/[()]/g, '').trim();
    
    // Convert German decimal separator to English
    const normalizedLK = cleanLK.replace(',', '.');
    
    const parsed = parseFloat(normalizedLK);
    return isNaN(parsed) ? null : parsed;
}

function normalizeIdentityName(value) {
    return String(value || '')
        .normalize('NFC')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function buildIdentityNameVariants(value) {
    const normalized = normalizeIdentityName(value);
    if (!normalized) return [];

    const direct = normalized;
    const compact = normalized.replace(/[^a-z0-9äöüß]/gi, '');

    if (!normalized.includes(',')) {
        return [direct, compact].filter(Boolean);
    }

    const parts = normalized.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
        return [direct, compact].filter(Boolean);
    }

    const swapped = `${parts.slice(1).join(' ')} ${parts[0]}`.replace(/\s+/g, ' ').trim();
    const swappedCompact = swapped.replace(/[^a-z0-9äöüß]/gi, '');
    return [direct, compact, swapped, swappedCompact].filter(Boolean);
}

function namesLikelyReferToSamePerson(expectedName, candidateName) {
    const expectedVariants = new Set(buildIdentityNameVariants(expectedName));
    const candidateVariants = new Set(buildIdentityNameVariants(candidateName));
    if (expectedVariants.size === 0 || candidateVariants.size === 0) return false;

    for (const variant of expectedVariants) {
        if (candidateVariants.has(variant)) return true;
    }
    return false;
}

function validateProfileIdentityAgainstMatches(profileName, matches) {
    const safeMatches = Array.isArray(matches) ? matches : [];
    const expected = String(profileName || '').trim();
    if (!expected) {
        return {
            valid: false,
            checkedRows: safeMatches.length,
            mismatchRows: safeMatches.length,
            reason: 'profile_name_missing',
            mismatchSamples: []
        };
    }

    let mismatchRows = 0;
    const mismatchSamples = [];

    for (const match of safeMatches) {
        const names = [
            match?.scraped_from_player,
            match?.team1_player1_name,
            match?.team1_player2_name,
            match?.team2_player1_name,
            match?.team2_player2_name
        ].filter((value) => String(value || '').trim().length > 0);

        const found = names.some((name) => namesLikelyReferToSamePerson(expected, name));
        if (!found) {
            mismatchRows += 1;
            if (mismatchSamples.length < 5) {
                mismatchSamples.push({
                    match_date: match?.match_date || null,
                    event_name: match?.event_name || null,
                    names
                });
            }
        }
    }

    return {
        valid: mismatchRows === 0,
        checkedRows: safeMatches.length,
        mismatchRows,
        reason: mismatchRows === 0 ? null : 'profile_history_identity_mismatch',
        mismatchSamples
    };
}

/**
 * Extract LK improvement value from the correct cell (column 3)
 */
function extractLKImprovement(cells) {
    // LK improvement is in column 3 (cells[3])
    if (cells.length > 3) {
        const lkCell = cells[3];
        const lkSpan = lkCell.querySelector('span.z-label');
        
        if (lkSpan) {
            const lkText = lkSpan.textContent?.trim();
            
            // Look for patterns like "0,045", "-0,025", etc.
            // Exclude empty strings and very long text
            if (lkText && lkText.length < 10) {
                const lkMatch = lkText.match(/^([+-]?\d+[,.]?\d*)$/);
                if (lkMatch) {
                    const lkValue = lkMatch[1].replace(',', '.');
                    return parseFloat(lkValue);
                }
            }
        }
    }
    
    return null;
}

/**
 * Winner determination using UI border color as primary signal, score parsing as fallback.
 * LK improvement is intentionally excluded — pro players always receive 0 regardless of
 * outcome, so it is not a reliable signal. It is stored separately as a raw data field.
 */
function determineWinnerEnhanced(player1Name, player2Name, scoreDetails, resultIndicator,
                                 player1Partner = '', player2Partner = '') {

    // Create team identifiers
    const team1 = player1Partner ? `${player1Name} / ${player1Partner}` : player1Name;
    const team2 = player2Partner ? `${player2Name} / ${player2Partner}` : player2Name;

    // Priority 1: UI border color — green rgb(172,198,9) = Win, orange rgb(208,74,0) = Loss
    if (resultIndicator === 'Win') {
        return team1; // Green border = scraped player won
    } else if (resultIndicator === 'Loss') {
        return team2; // Red border = scraped player lost
    }
    
    // Priority 3: Analyze score structure for edge cases
    if (scoreDetails && scoreDetails.sets && scoreDetails.sets.length > 0) {
        
        // Handle retirement cases - winner is player leading when retirement occurred
        if (scoreDetails.retirement) {
            return determineRetirementWinner(team1, team2, scoreDetails, resultIndicator);
        }
        
        // Handle completed matches
        if (scoreDetails.completed) {
            let team1Sets = 0;
            let team2Sets = 0;
            
            scoreDetails.sets.forEach(set => {
                if (set.p1_games > set.p2_games) {
                    team1Sets++;
                } else if (set.p2_games > set.p1_games) {
                    team2Sets++;
                }
            });
            
            if (team1Sets > team2Sets) {
                return team1;
            } else if (team2Sets > team1Sets) {
                return team2;
            }
        }
    }
    
    // Priority 4: Handle not played matches
    if (scoreDetails && (scoreDetails.walkover || scoreDetails.type === 'not_played')) {
        return null; // No winner for unplayed matches
    }
    
    return null; // Unable to determine winner
}

/**
 * Determine winner in retirement scenarios based on border color.
 */
function determineRetirementWinner(team1, team2, scoreDetails, resultIndicator) {
    // For retirements, the winner is whoever did NOT retire — trust the border color.
    // Do not use score analysis: the retiring player might be leading when they stop.
    
    if (resultIndicator === 'Win') {
        return team1; // Opponent retired, scraped player won
    } else if (resultIndicator === 'Loss') {
        return team2; // Scraped player retired, opponent won
    }
    
    // Note: We do NOT use score analysis for retirements because:
    // - Leading player might be the one who retired (injury, etc.)
    // - The non-retiring player always gets the win regardless of score
    // - Border colors and LK improvements accurately reflect the actual winner
    
    console.warn('Retirement detected but no clear result indicator - relying on other methods');
    return null; // Let the main winner determination logic handle it
}

/**
 * Helper function to extract LK rating from team string
 */
function extractLKFromTeamString(teamString, playerIndex) {
    const players = teamString.split(' / ');
    if (players[playerIndex]) {
        const lkMatch = players[playerIndex].match(/\(LK ([\d.]+)\)/);
        return lkMatch ? parseFloat(lkMatch[1]) : null;
    }
    return null;
}

/**
 * Enhanced format match data for database insertion with universal hashing and LK improvements
 */
function formatMatchForDatabase(matchData, currentDate, currentEventName) {
    // Parse basic data
    const matchDate = matchData.date || currentDate;
    const formattedDate = parseGermanDate(matchDate);
    const player1LK = parseLKValue(matchData.player1LK);
    const player2LK = parseLKValue(matchData.player2LK);
    const isDouble = !!(matchData.player1Partner || matchData.player2Partner);
    const eventName = matchData.event || currentEventName;
    
    // Enhanced score parsing
    const scoreDetails = parseScoreEnhanced(matchData.score);
    
    // Generate universal hash
    const matchHash = generateUniversalMatchHash(
        matchData.player1,
        player1LK,
        matchData.player2,
        player2LK,
        formattedDate,
        eventName,
        matchData.player1Partner,
        matchData.player2Partner,
        matchData.score,
        matchData.player1PartnerLK,
        matchData.player2PartnerLK
    );
    
    // Winner determination via UI border color, with score parsing as fallback
    const absoluteWinner = determineWinnerEnhanced(
        matchData.player1,
        matchData.player2,
        scoreDetails,
        matchData.result,
        matchData.player1Partner,
        matchData.player2Partner
    );
    
    // Normalize players for database storage (with LK values)
    const dbNormalized = normalizePlayersForDatabase(
        matchData.player1, player1LK, matchData.player2, player2LK,
        matchData.player1Partner, matchData.player2Partner, 
        matchData.player1PartnerLK, matchData.player2PartnerLK
    );
    
    // Store normalized score
    const normalizedScore = normalizeScore(matchData.score, dbNormalized.team1IsOriginalTeam1);
    const normalizedScoreDetails = parseScoreEnhanced(normalizedScore);
    
    // Determine match type and completion status
    const isWalkover = scoreDetails ? (scoreDetails.walkover || scoreDetails.type === 'not_played') : false;
    const isRetirement = scoreDetails ? scoreDetails.retirement : false;
    const isCompleted = scoreDetails ? scoreDetails.completed : false;
    
    // Derive canonical winner_side (1 = normalized team1, 2 = normalized team2, null = unknown)
    const originalTeam1 = matchData.player1Partner
        ? `${matchData.player1} / ${matchData.player1Partner}`
        : matchData.player1;
    const originalTeam2 = matchData.player2Partner
        ? `${matchData.player2} / ${matchData.player2Partner}`
        : matchData.player2;

    let winnerSide = null;
    if (absoluteWinner === originalTeam1) {
        winnerSide = dbNormalized.team1IsOriginalTeam1 ? 1 : 2;
    } else if (absoluteWinner === originalTeam2) {
        winnerSide = dbNormalized.team1IsOriginalTeam1 ? 2 : 1;
    }
    
    console.log(`🏆 Winner resolution: result="${matchData.result}", team1IsOriginal=${dbNormalized.team1IsOriginalTeam1}, winner_side=${winnerSide}`);
    
    const lkImprovementSlots = buildLkImprovementSlots(
        dbNormalized,
        matchData.player1,
        matchData.lkImprovement
    );
    
    
    return {
        // Universal identifiers
        match_hash: matchHash,
        match_date: formattedDate,
        event_name: eventName,
        
        // Match characteristics
        is_double: isDouble,
        is_walkover: isWalkover,
        is_retirement: isRetirement,
        is_completed: isCompleted,
        
        // Normalized player data (consistent regardless of scraping source)
        team1_player1_name: dbNormalized.team1Players[0]?.name || null,
        team1_player1_lk: dbNormalized.team1Players[0]?.lk || null,
        team1_player2_name: dbNormalized.team1Players[1]?.name || null,
        team1_player2_lk: dbNormalized.team1Players[1]?.lk || null,
        
        team2_player1_name: dbNormalized.team2Players[0]?.name || null,
        team2_player1_lk: dbNormalized.team2Players[0]?.lk || null,
        team2_player2_name: dbNormalized.team2Players[1]?.name || null,
        team2_player2_lk: dbNormalized.team2Players[1]?.lk || null,
        ...lkImprovementSlots,
        
        // Score information
        normalized_score: normalizedScore,
        normalized_score_details: normalizedScoreDetails,
        
        // Winner information
        winning_team: absoluteWinner,
        winner_side: winnerSide,
        
        // Original scraping context (for debugging and DTB ID updates)
        scraped_from_player: matchData.player1,
        original_score: matchData.score,
        original_result_indicator: matchData.result,
        team_order_swapped: !dbNormalized.team1IsOriginalTeam1,
        
        // Metadata
        scraped_at: new Date().toISOString(),
        source_url: window.location.href,
        
        // Legacy compatibility  
        playersDisplay: `${dbNormalized.team1} vs. ${dbNormalized.team2}`
    };
}

/**
 * Finds a label element by its text content and returns the value from its corresponding value element.
 */
function getValueByLabel(labelText) {
    const allSpans = document.querySelectorAll('span.zk-font-12');
    let foundValue = null;
    allSpans.forEach(span => {
        if (span.textContent.trim() === labelText) {
            try {
                const valueSpan = span.parentElement.nextElementSibling.querySelector('.zk-font-bold');
                if (valueSpan) {
                    foundValue = valueSpan.textContent.trim();
                }
            } catch (e) {}
        }
    });
    return foundValue;
}

/**
 * Scrapes all visible player data and checks for profile ownership.
 */
function scrapeVisiblePlayerData() {
    // Find player name elements
    const nameElements = document.querySelectorAll('.zk-font-light.zk-color-deep-sea-baby.z-label');
    let fullName = null;
    if (nameElements.length > 0) {
        const playerNameElement = Array.from(nameElements).find(el => el.textContent.trim() !== 'Spielerprofil');
        fullName = playerNameElement?.textContent.trim() || null;
    }

    const accountButton = Array.from(document.querySelectorAll('button'))
                               .find(el => {
                                   const isVisible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                                   return el.textContent.includes('Accounteinstellungen ändern') && isVisible;
                               });
    
    const playerData = {
        fullName: fullName,
        leistungsklasse: document.querySelector('.profilbadge-max')?.textContent.trim() || null,
        dtbId: getValueByLabel("DTB-ID"),
        club: getValueByLabel("Verein"),
        nationality: getValueByLabel("Nationalität"),
        association: getValueByLabel("Landesverband"),
        isOwner: !!accountButton,
        url: window.location.href,
        timestamp: Date.now()
    };

    console.log("✅ Scraped Player Data:", playerData);
    return playerData;
}

function getCurrentPlayerIdentitySnapshot() {
    const data = scrapeVisiblePlayerData();
    return {
        url: window.location.href,
        isPlayerProfilePage: isPlayerProfilePage(),
        isLoaded: !!isPlayerDataLoaded(),
        dtbId: data?.dtbId || null,
        fullName: data?.fullName || null
    };
}

/**
 * Enhanced match history scraping with proper database format and error handling
 */
function scrapeMatchHistory() {
    try {
        console.log("🔍 Starting match history scraping...");
        const results = [];
        const tableBody = selectBestMatchHistoryTableBody();

        if (!tableBody) {
            console.error("❌ Could not find the results table body for match history.");
            return [];
        }

        const rows = tableBody.querySelectorAll('tr.z-row');
        
        let currentDate = '';
        let currentEventName = '';
        let processedRows = 0;
        let skippedRows = 0;
        let errorRows = 0;

        for (const row of rows) {
            try {
                processedRows++;
                const cells = row.querySelectorAll('td');
                
                // Check if this is a mobile/responsive layout row
                if (cells.length === 1 && cells[0].getAttribute('colspan') === '6') {
                    console.log(`📱 Processing mobile row ${processedRows}`);
                    const mobileMatch = scrapeMobileMatchRow(row, currentDate, currentEventName);
                    if (mobileMatch) {
                        if (mobileMatch.isDateRow) {
                            currentDate = mobileMatch.date;
                            continue;
                        } else if (mobileMatch.isEventRow) {
                            currentEventName = mobileMatch.event;
                            continue;
                        } else {
                            if (mobileMatch.date) currentDate = mobileMatch.date;
                            if (mobileMatch.event) currentEventName = mobileMatch.event;
                            // Format the match data for database
                            const formattedMatch = formatMatchForDatabase(mobileMatch, currentDate, currentEventName);
                            results.push(formattedMatch);
                            console.log(`✅ Mobile match added: ${mobileMatch.player1} vs ${mobileMatch.player2}`);
                        }
                    } else {
                        skippedRows++;
                    }
                    continue;
                }

                // Handle desktop layout with enhanced error handling
                if (cells.length < 6) {
                    // Skip calendar week rows
                    if (row.querySelector('.zk-font-bold.z-label[id*="KW"]')) {
                        console.log(`📅 Calendar week row ${processedRows} - skipping`);
                        continue;
                    }
                    // Skip empty rows
                    if (cells.length === 1 && cells[0].textContent.trim() === '') {
                        console.log(`⚪ Empty row ${processedRows} - skipping`);
                        continue;
                    }
                    console.log(`⚠️ Row ${processedRows}: insufficient cells (${cells.length}), skipping`);
                    skippedRows++;
                    continue; 
                }

                const dateCellText = cells[0]?.innerText.trim();
                const eventCell = cells[4];
                const scoreCell = cells[5];

                if (!eventCell || !scoreCell) {
                    console.log(`⚠️ Row ${processedRows}: missing event or score cell, skipping`);
                    skippedRows++;
                    continue;
                }

                const matchBadge = eventCell.querySelector('.matchbadge.z-label');

                if (matchBadge) {
                    currentEventName = matchBadge.textContent.trim();
                    if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateCellText)) {
                        currentDate = dateCellText;
                    } else if (dateCellText.startsWith('KW')) {
                        currentDate = '';
                    }
                    continue;
                }
                
                const player1NameEl = eventCell.querySelector('div.z-hlayout > div:nth-child(1) .zk-font-bold');

                if (player1NameEl) {
                    console.log(`👤 Processing match row ${processedRows}...`);
                    console.log(`📅 Current context - Date: "${currentDate}", Event: "${currentEventName}"`);
                    
                    const matchDate = dateCellText || currentDate;
                    const player1Box = eventCell.querySelector('div.z-hlayout > div:nth-child(1)');
                    const player2Box = eventCell.querySelector('div.z-hlayout > div:nth-child(3)');

                    if (!player1Box || !player2Box) {
                        console.log(`⚠️ Row ${processedRows}: missing player boxes, skipping`);
                        skippedRows++;
                        continue;
                    }

                    // Enhanced player name extraction with multiple fallbacks
                    let player1Name = player1Box.querySelector('.zk-font-bold')?.innerText.trim();
                    const player1LK = player1Box.querySelector('.zk-font-12')?.innerText.trim().replace(/[()]/g, '') || '';
                    
                    let player2Name = player2Box.querySelector('.zk-font-bold')?.innerText.trim();
                    const player2LK = player2Box.querySelector('.zk-font-12')?.innerText.trim().replace(/[()]/g, '') || '';
                    
                    // Fallback: try to find player names in clickable links if direct selection fails
                    if (!player1Name) {
                        const player1Link = player1Box.querySelector('a.z-toolbarbutton .zk-font-bold');
                        player1Name = player1Link?.innerText.trim() || '';
                    }
                    
                    if (!player2Name) {
                        const player2Link = player2Box.querySelector('a.z-toolbarbutton .zk-font-bold');
                        player2Name = player2Link?.innerText.trim() || '';
                    }
                    
                    // Enhanced partner detection with smart logic
                    const player1ToolbarButtons = player1Box.querySelectorAll('a.z-toolbarbutton');
                    const player2ToolbarButtons = player2Box.querySelectorAll('a.z-toolbarbutton');
                    
                    console.log(`🔍 Player1 box has ${player1ToolbarButtons.length} toolbar buttons`);
                    console.log(`🔍 Player2 box has ${player2ToolbarButtons.length} toolbar buttons`);
                    
                    // Enhanced partner detection with LK extraction
                    let player1Partner = '';
                    let player1PartnerLK = '';
                    for (const button of player1ToolbarButtons) {
                        const buttonText = button.innerText.trim();
                        if (buttonText && buttonText !== player1Name) {
                            player1Partner = buttonText;
                            // Look for LK value in the next sibling element
                            const nextElement = button.parentElement?.nextElementSibling?.querySelector('.zk-font-12');
                            if (nextElement) {
                                player1PartnerLK = nextElement.innerText.trim().replace(/[()]/g, '') || '';
                            }
                            console.log(`🤝 Player1 partner detected: "${player1Partner}", LK: "${player1PartnerLK}"`);
                            break;
                        }
                    }
                    
                    let player2Partner = '';
                    let player2PartnerLK = '';
                    for (const button of player2ToolbarButtons) {
                        const buttonText = button.innerText.trim();
                        if (buttonText && buttonText !== player2Name) {
                            player2Partner = buttonText;
                            // Look for LK value in the next sibling element
                            const nextElement = button.parentElement?.nextElementSibling?.querySelector('.zk-font-12');
                            if (nextElement) {
                                player2PartnerLK = nextElement.innerText.trim().replace(/[()]/g, '') || '';
                            }
                            console.log(`🤝 Player2 partner detected: "${player2Partner}", LK: "${player2PartnerLK}"`);
                            break;
                        }
                    }
                    
                    console.log(`🔍 Final partners: Player1="${player1Partner || 'none'}", Player2="${player2Partner || 'none'}"`);
                    console.log(`🔍 Main players: Player1="${player1Name}", Player2="${player2Name}"`);

                    // Validate player names
                    if (!player1Name || !player2Name || player1Name === 'null' || player2Name === 'null') {
                        console.log(`⚠️ Row ${processedRows}: invalid player names (${player1Name} vs ${player2Name}), skipping`);
                        skippedRows++;
                        continue;
                    }

                    // Extract LK improvement and score
                    const lkImprovement = extractLKImprovement(cells);
                    
                    const scoreBox = scoreCell.querySelector('div.z-hlayout');
                    const scoreSpans = scoreBox?.querySelectorAll('span.z-label');
                    const score = Array.from(scoreSpans || []).map(s => s.innerText).join(' ').trim();

                    // Determine result from border color
                    const resultBorderColor = scoreBox ? window.getComputedStyle(scoreBox).borderLeftColor : '';
                    let result = 'Unknown';
                    
                    if (resultBorderColor.includes('rgb(172, 198, 9)')) {
                        result = 'Win';
                    } else if (resultBorderColor.includes('rgb(208, 74, 0)')) {
                        result = 'Loss';
                    } else if (score.toLowerCase() === 'n.a.') {
                        result = 'Not Played';
                    }

                    if (result === 'Unknown' && /\bAufg\.?/.test(score)) {
                        console.warn('Retirement score detected but border color was unreadable; leaving result as Unknown');
                    }

                    const matchData = {
                        date: matchDate,
                        event: currentEventName,
                        player1: player1Name,
                        player1LK: player1LK,
                        player1Partner: player1Partner,
                        player1PartnerLK: player1PartnerLK,
                        player2: player2Name,
                        player2LK: player2LK,
                        player2Partner: player2Partner,
                        player2PartnerLK: player2PartnerLK,
                        score: score,
                        result: result,
                        lkImprovement: lkImprovement
                    };

                    const matchDisplayText = player1Partner || player2Partner 
                        ? `${player1Name}${player1Partner ? ' / ' + player1Partner : ''} vs ${player2Name}${player2Partner ? ' / ' + player2Partner : ''}`
                        : `${player1Name} vs ${player2Name}`;
                    

                    // Format for database and add to results
                    const formattedMatch = formatMatchForDatabase(matchData, currentDate, currentEventName);
                    results.push(formattedMatch);
                } else {
                    // Check if this is a calendar week row we missed
                    if (dateCellText.startsWith('KW') && cells[1].textContent.trim() === '') {
                        console.log(`📅 Calendar week row ${processedRows} (alternative format) - skipping`);
                        continue;
                    }
                    
                    // Debug: Let's see what's in these "no player name element" rows
                    console.log(`⚠️ Row ${processedRows}: no player name element found`);
                    console.log(`  Date cell: "${dateCellText}"`);
                    console.log(`  Event cell content: "${eventCell?.textContent?.trim().substring(0, 100)}"`);
                    console.log(`  Event cell HTML: ${eventCell?.outerHTML?.substring(0, 200)}...`);
                    
                    // Try to extract date or event from these rows
                    if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateCellText)) {
                        currentDate = dateCellText;
                        console.log(`📅 Found date in skipped row: "${currentDate}"`);
                        
                        // Check for event in this row
                        const eventText = eventCell?.textContent?.trim();
                        if (eventText && eventText.length > 5) {
                            currentEventName = eventText;
                        }
                        continue;
                    }
                    
                    skippedRows++;
                }
            } catch (rowError) {
                console.error(`❌ Error processing row ${processedRows}:`, rowError);
                errorRows++;
                // Continue processing other rows
            }
        }

        
        return results;
        
    } catch (error) {
        console.error("❌ Fatal error in scrapeMatchHistory:", error);
        return [];
    }
}

function selectBestMatchHistoryTableBody() {
    const candidates = Array.from(document.querySelectorAll('.gbtrninfo-true .z-groupbox-content .z-grid-body .z-rows'));
    if (candidates.length === 0) return null;

    let bestCandidate = null;
    let bestScore = -1;

    for (const body of candidates) {
        const rows = Array.from(body.querySelectorAll('tr.z-row'));
        const mobileRows = rows.filter(row => {
            const td = row.querySelector('td[colspan="6"]');
            return !!td && !!row.querySelector('.z-vlayout');
        }).length;
        const desktopRows = rows.filter(row => row.querySelectorAll('td').length >= 6).length;
        const eventRows = rows.filter(row => row.querySelector('.matchbadge.z-label')).length;
        const container = body.closest('.z-grid');
        const style = container ? window.getComputedStyle(container) : null;
        const isVisible = !style || (style.display !== 'none' && style.visibility !== 'hidden');

        const score = (isVisible ? 1000 : 0) + (mobileRows * 5) + (desktopRows * 3) + (eventRows * 2) + rows.length;
        if (score > bestScore) {
            bestScore = score;
            bestCandidate = body;
        }
    }

    if (bestCandidate) {
        console.log(`🎯 Selected match history table body from ${candidates.length} candidates`);
    }
    return bestCandidate;
}

function extractNameAndLKFromMobilePlayerBox(playerBox) {
    if (!playerBox) {
        return { name: '', lk: '' };
    }

    const rawName =
        playerBox.querySelector('.zk-font-bold')?.textContent ||
        playerBox.querySelector('a.z-toolbarbutton .z-toolbarbutton-content')?.textContent ||
        '';

    const name = rawName.replace(/\s+/g, ' ').trim();
    const lkText = playerBox.querySelector('.zk-font-12')?.textContent || '';
    const lkMatch = lkText.match(/LK\s*([0-9]+(?:[.,][0-9]+)?)/i);
    const lk = lkMatch ? lkMatch[1] : lkText.replace(/[()]/g, '').trim();

    return { name, lk };
}

function extractMobileLKImprovement(vlayout) {
    const lkLabel = Array.from(vlayout.querySelectorAll('span.z-label')).find(span =>
        span.textContent?.includes('LK-Verbesserung')
    );
    if (!lkLabel) return null;

    const lkContainer = lkLabel.closest('.z-vlayout');
    if (!lkContainer) return null;

    const valueText = Array.from(lkContainer.querySelectorAll('span.z-label'))
        .map(span => span.textContent?.replace(/\s+/g, ' ').trim() || '')
        .find(text => /^[+-]?\d+[.,]\d+$/.test(text));

    if (!valueText) return null;
    const normalized = parseFloat(valueText.replace(',', '.'));
    return Number.isNaN(normalized) ? null : normalized;
}

/**
 * Scrapes match data from mobile/responsive layout rows
 */
function scrapeMobileMatchRow(row, currentDate, currentEventName) {
    try {
        const vlayout = row.querySelector('.z-vlayout');
        if (!vlayout) return null;

        // Check for date row (has date in bold)
        const dateElement = vlayout.querySelector('.zk-font-bold.z-label');
        if (dateElement && /^\d{2}\.\d{2}\.\d{4}$/.test(dateElement.textContent.trim())) {
            return {
                isDateRow: true,
                date: dateElement.textContent.trim()
            };
        }

        // Check for event badge
        const matchBadge = vlayout.querySelector('.matchbadge.z-label');
        if (matchBadge) {
            return {
                isEventRow: true,
                event: matchBadge.textContent.trim()
            };
        }

        const versusLabel = Array.from(vlayout.querySelectorAll('span.z-label')).find(span =>
            span.textContent?.trim().toLowerCase() === 'versus'
        );
        const versusRow = versusLabel?.closest('.z-hlayout.z-flex.z-flex-row');
        if (!versusRow) return null;

        const playerBoxes = Array.from(versusRow.querySelectorAll('.zk-container-alignleft.z-div'))
            .filter(div => div.textContent?.toLowerCase().includes('(lk'));

        if (playerBoxes.length < 2) {
            return null;
        }

        const team1Players = extractMobilePlayersFromBox(playerBoxes[0]);
        const team2Players = extractMobilePlayersFromBox(playerBoxes[1]);

        if (!team1Players[0]?.name || !team2Players[0]?.name) {
            return null;
        }

        const resultContainer = Array.from(vlayout.querySelectorAll('div[style*=\"border-left\"]')).find(div => {
            const inlineStyle = div.getAttribute('style') || '';
            return inlineStyle.includes('rgb(172, 198, 9)') || inlineStyle.includes('rgb(208, 74, 0)');
        }) || vlayout.querySelector('div[style*=\"border-left\"]');

        const scoreCandidates = Array.from(resultContainer?.querySelectorAll('span.z-label') || [])
            .map(span => span.textContent?.replace(/\s+/g, ' ').trim() || '')
            .filter(text => /^(\d+:\d+(\s*\(\d+:\d+\))?|n\.a\.|aufg\.)$/i.test(text));

        const score = scoreCandidates.join(' ').trim();
        let result = 'Unknown';

        if (resultContainer) {
            const inlineStyle = resultContainer.getAttribute('style') || '';
            const computedBorderColor = window.getComputedStyle(resultContainer).borderLeftColor || '';
            const borderColorSource = `${inlineStyle} ${computedBorderColor}`;

            if (borderColorSource.includes('rgb(172, 198, 9)')) {
                result = 'Win';
            } else if (borderColorSource.includes('rgb(208, 74, 0)')) {
                result = 'Loss';
            }
        }

        if (score.toLowerCase() === 'n.a.') {
            result = 'Not Played';
        }

        const textDateMatch = vlayout.textContent?.match(/(\d{2}\.\d{2}\.\d{4})/);
        const inferredDate = textDateMatch ? textDateMatch[1] : currentDate;

        return {
            date: inferredDate,
            event: currentEventName,
            player1: team1Players[0].name,
            player1LK: team1Players[0].lk,
            player1Partner: team1Players[1]?.name || '',
            player1PartnerLK: team1Players[1]?.lk ?? '',
            player2: team2Players[0].name,
            player2LK: team2Players[0].lk,
            player2Partner: team2Players[1]?.name || '',
            player2PartnerLK: team2Players[1]?.lk ?? '',
            score: score,
            result: result,
            lkImprovement: extractMobileLKImprovement(vlayout)
        };
    } catch (e) {
        console.error("Error scraping mobile match row:", e, row.outerHTML);
        return null;
    }
}

/**
 * Checks if player data has changed
 */
function hasPlayerDataChanged() {
    const currentUrl = window.location.href;
    return currentUrl !== lastScrapedUrl;
}

/**
 * Safely disconnect the current observer
 */
function disconnectCurrentObserver() {
    if (currentObserver) {
        currentObserver.disconnect();
        currentObserver = null;
        isCurrentlyObserving = false;
        console.log("🔍 MutationObserver disconnected");
    }
}

/**
 * Checks if player data elements are present and valid
 */
function isPlayerDataLoaded() {
    // Check for multiple indicators that the player profile has loaded
    const lkBadge = document.querySelector('.profilbadge-max');
    const nameElements = document.querySelectorAll('.zk-font-light.zk-color-deep-sea-baby.z-label');
    const playerNameElement = Array.from(nameElements).find(el => 
        el.textContent.trim() !== 'Spielerprofil' && el.textContent.trim() !== ''
    );
    
    return lkBadge && playerNameElement;
}

/**
 * Attempts to scrape player data if it's loaded
 */
function attemptPlayerDataScrape() {
    if (!isPlayerProfilePage()) {
        console.log("Not a player profile page. Skipping scraper.");
        disconnectCurrentObserver();
        return false;
    }

    if (!hasPlayerDataChanged()) {
        console.log("Player data hasn't changed, skipping rescrape.");
        return false;
    }

    if (isPlayerDataLoaded()) {
        console.log("Player data appears to be loaded. Running scraper.");
        const playerData = scrapeVisiblePlayerData();
        
        // Update the last scraped URL
        lastScrapedUrl = window.location.href;
        
        // Send the scraped data
        chrome.runtime.sendMessage({
            action: "playerDataScraped",
            data: playerData
        }).catch(error => {
            console.log("Failed to send player data to background script:", error);
        });
        
        return true;
    }
    
    return false;
}

/**
 * Main function to start observing for player data changes
 */
function startObservingPlayerData() {
    // First disconnect any existing observer
    disconnectCurrentObserver();
    
    // Try immediate scrape first
    if (attemptPlayerDataScrape()) {
        console.log("✅ Player data scraped immediately, but continuing to observe for changes");
    }

    // Always set up observer for potential changes
    const targetNode = document.body;
    const config = { 
        childList: true, 
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
    };

    currentObserver = new MutationObserver((mutations, obs) => {
        // Debounce the mutations - only check after a brief pause
        clearTimeout(currentObserver.debounceTimeout);
        currentObserver.debounceTimeout = setTimeout(() => {
            attemptPlayerDataScrape();
        }, 500);
    });

    // Start observing
    currentObserver.observe(targetNode, config);
    isCurrentlyObserving = true;
    console.log("🔍 Started observing for player data changes");
}

/**
 * Handles URL changes and restarts observation
 */
function handleUrlChange() {
    console.log("🔄 URL changed to:", window.location.href);
    
    // Small delay to allow DOM to settle after navigation
    setTimeout(() => {
        startObservingPlayerData();
    }, 100);
}

/**
 * Set up navigation listeners
 */
function setupNavigationListeners() {
    // Listen for pushState/replaceState (SPA navigation)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(...args) {
        originalPushState.apply(this, args);
        handleUrlChange();
    };
    
    history.replaceState = function(...args) {
        originalReplaceState.apply(this, args);
        handleUrlChange();
    };
    
    // Listen for popstate events (back/forward buttons)
    window.addEventListener('popstate', handleUrlChange);
    
    // Listen for hashchange events
    window.addEventListener('hashchange', handleUrlChange);
}

/**
 * Clicks the "Ranking" tab if not already active.
 */
async function clickRankingTab() {
    const rankingTab = Array.from(document.querySelectorAll('.z-tab')).find(tab => {
        return tab.id === 'tRrKg1' || tab.querySelector('.z-tab-text')?.textContent.trim() === 'Ranking';
    });

    if (rankingTab && !rankingTab.classList.contains('z-tab-selected')) {
        console.log("Clicking 'Ranking' tab.");
        rankingTab.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
    }
    console.log("'Ranking' tab already active or not found.");
    return false;
}

/**
 * Clicks the "Gewertete Spiele" groupbox to expand it if it's collapsed.
 */
async function expandRankedGamesSection() {
    let rankedGamesGroupboxHeader = document.getElementById('oCMXlh');
    let rankedGamesGroupbox = null;

    if (rankedGamesGroupboxHeader) {
        rankedGamesGroupbox = rankedGamesGroupboxHeader.closest('.z-groupbox');
    }

    if (!rankedGamesGroupbox) {
        rankedGamesGroupbox = Array.from(document.querySelectorAll('.z-groupbox')).find(groupbox => {
            return groupbox.querySelector('.z-caption .zk-font-22.z-label')?.textContent.trim() === 'Gewertete Spiele';
        });
    }

    if (rankedGamesGroupbox && !rankedGamesGroupbox.classList.contains('gbopen-true')) {
        console.log("Expanding 'Gewertete Spiele' section.");
        const toggleButton = rankedGamesGroupbox.querySelector('.z-groupbox-header .z-caption-content') ||
                             rankedGamesGroupbox.querySelector('.z-groupbox-header span.z-label');
        if (toggleButton) {
            toggleButton.click();
            await new Promise(resolve => setTimeout(resolve, 1000));
            return true;
        }
    }
    console.log("'Gewertete Spiele' section already expanded or toggle not found.");
    return false;
}

/**
 * Clicks the "Alle Spiele laden" button if it exists.
 */
async function clickShowAllGamesButton() {
    const showAllButton = Array.from(document.querySelectorAll('button')).find(button => {
        return button.textContent.trim() === 'Alle Spiele laden';
    });
    
    if (showAllButton && showAllButton.style.display !== 'none' && !showAllButton.disabled) {
        console.log("Clicking 'Alle Spiele laden' button.");
        showAllButton.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
        return true;
    }
    console.log("'Alle Spiele laden' button not found, not visible, or already clicked/disabled.");
    return false;
}

/**
 * Clicks the previous pagination button for match history.
 */
async function clickPreviousMatchPage() {
    const prevButton = Array.from(document.querySelectorAll('button.btn-round-white.z-button')).find(button => {
        const img = button.querySelector('img');
        return img && img.src.includes('arrow_left.svg') && !img.src.includes('arrow_left_disabled.svg');
    });

    if (prevButton && !prevButton.disabled) {
        console.log("Clicking previous match history page button.");
        prevButton.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return true;
    }
    console.log("No previous match history page button found or it's disabled.");
    return false;
}

function dedupeMatchesByHash(matches) {
    const byHash = new Map();
    for (const match of matches || []) {
        const key = match?.match_fingerprint || match?.match_hash || JSON.stringify(match);
        if (!byHash.has(key)) {
            byHash.set(key, match);
        }
    }
    return Array.from(byHash.values());
}

function extractMobilePlayersFromBox(playerBox) {
    if (!playerBox) return [];

    const nameNodes = Array.from(playerBox.querySelectorAll(
        'span.zk-font-bold.z-label, a.z-toolbarbutton span.z-toolbarbutton-content'
    ));
    const lkNodes = Array.from(playerBox.querySelectorAll('span.zk-font-12.z-label'));

    const names = nameNodes
        .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    const lks = lkNodes
        .map(node => parseLKValue((node.textContent || '').trim()))
        .filter(lk => lk !== null);

    if (names.length === 0) return [];

    return names.slice(0, 2).map((name, idx) => ({
        name,
        lk: lks[idx] ?? null
    }));
}

function buildLkImprovementSlots(dbNormalized, scrapedPlayerName, lkImprovement) {
    const empty = {
        team1_player1_lk_improvement: null,
        team1_player2_lk_improvement: null,
        team2_player1_lk_improvement: null,
        team2_player2_lk_improvement: null
    };

    if (lkImprovement === null || lkImprovement === undefined || !scrapedPlayerName) {
        return empty;
    }

    const normalizedScraped = normalizeForHash(scrapedPlayerName);
    const slots = [
        { key: 'team1_player1_lk_improvement', player: dbNormalized.team1Players[0] },
        { key: 'team1_player2_lk_improvement', player: dbNormalized.team1Players[1] },
        { key: 'team2_player1_lk_improvement', player: dbNormalized.team2Players[0] },
        { key: 'team2_player2_lk_improvement', player: dbNormalized.team2Players[1] }
    ];

    for (const slot of slots) {
        if (!slot.player?.name) continue;
        if (normalizeForHash(slot.player.name) === normalizedScraped) {
            return {
                ...empty,
                [slot.key]: lkImprovement
            };
        }
    }

    return empty;
}

function hasMatchesOlderThanCutoff(matches, latestKnownMatchDate) {
    if (!latestKnownMatchDate) return false;
    return (matches || []).some((match) =>
        typeof match?.match_date === 'string' && match.match_date < latestKnownMatchDate
    );
}

/**
 * Main function to orchestrate history scraping in two modes:
 * - full_backfill: scrape as far back as possible (including "Alle Spiele laden")
 * - incremental_update: scrape newest pages only until known history window is reached
 */
async function scrapeFullMatchHistory(options = {}) {
    const mode = options.mode === 'incremental_update' ? 'incremental_update' : 'full_backfill';
    const latestKnownMatchDate =
        typeof options.latestKnownMatchDate === 'string' ? options.latestKnownMatchDate : null;

    const meta = {
        mode,
        latestKnownMatchDate,
        clickedLoadAll: false,
        reachedHistoryStart: false,
        stoppedReason: null,
        pagesScrapedInitial: 0,
        pagesScrapedFull: 0,
        hadFatalError: false
    };

    let allMatches = [];
    const maxInitialPages = mode === 'incremental_update' ? 20 : 200;
    const maxDeepPages = 200;

    const profileIdentity = getCurrentPlayerIdentitySnapshot();
    const expectedProfileName = profileIdentity?.fullName || null;

    try {
        console.log(`🏁 Starting match history scraping in mode: ${mode}`);

        // 1. Navigate to the "Ranking" tab
        console.log("📂 Navigating to Ranking tab...");
        await clickRankingTab();

        // 2. Expand the "Gewertete Spiele" section
        console.log("📂 Expanding ranked games section...");
        await expandRankedGamesSection();

        // 3. Scrape regular paginated pages
        console.log("📄 Starting initial pagination scraping...");
        let hasPreviousPage = true;
        let pageCount = 0;

        while (hasPreviousPage && pageCount < maxInitialPages) {
            try {
                pageCount++;
                meta.pagesScrapedInitial = pageCount;
                console.log(`📄 Scraping page ${pageCount} of match history...`);
                const currentMatches = scrapeMatchHistory();
                allMatches = allMatches.concat(currentMatches);

                if (mode === 'incremental_update' && hasMatchesOlderThanCutoff(currentMatches, latestKnownMatchDate)) {
                    meta.stoppedReason = 'reached_known_history_window';
                    hasPreviousPage = false;
                    break;
                }

                hasPreviousPage = await clickPreviousMatchPage();
            } catch (pageError) {
                console.error(`❌ Error on page ${pageCount}:`, pageError);
                hasPreviousPage = await clickPreviousMatchPage();
            }
        }

        if (!hasPreviousPage) {
            meta.reachedHistoryStart = true;
        } else if (pageCount >= maxInitialPages) {
            meta.stoppedReason = meta.stoppedReason || 'max_pages_reached';
        }

        // Incremental catch-up mode:
        // if we still have previous pages after the initial window, we're likely behind by many matches.
        // In that case, click "Alle Spiele laden" and continue until we hit known history.
        const incrementalNeedsDeepScan =
            mode === 'incremental_update' &&
            !!latestKnownMatchDate &&
            hasPreviousPage;

        if (incrementalNeedsDeepScan) {
            console.log("🔁 Incremental window exhausted; escalating to 'Alle Spiele laden' for deep catch-up.");
            const clickedLoadAll = await clickShowAllGamesButton();
            meta.clickedLoadAll = clickedLoadAll;

            if (clickedLoadAll) {
                pageCount = 0;
                let hasPreviousPageFull = true;

                while (hasPreviousPageFull && pageCount < maxDeepPages) {
                    try {
                        pageCount++;
                        meta.pagesScrapedFull = pageCount;
                        console.log(`📄 Deep incremental page ${pageCount}...`);
                        const newMatches = scrapeMatchHistory();
                        allMatches = allMatches.concat(newMatches);

                        if (hasMatchesOlderThanCutoff(newMatches, latestKnownMatchDate)) {
                            meta.stoppedReason = 'reached_known_history_after_load_all';
                            break;
                        }

                        hasPreviousPageFull = await clickPreviousMatchPage();
                    } catch (pageError) {
                        console.error(`❌ Error on deep incremental page ${pageCount}:`, pageError);
                        hasPreviousPageFull = await clickPreviousMatchPage();
                    }
                }

                if (!hasPreviousPageFull) {
                    meta.reachedHistoryStart = true;
                } else if (pageCount >= maxDeepPages) {
                    meta.stoppedReason = meta.stoppedReason || 'max_pages_reached';
                }
            }
        }

        // 4. Full mode: click "Alle Spiele laden" and scrape older pages too
        if (mode === 'full_backfill') {
            console.log("🔍 Checking for 'Alle Spiele laden' button...");
            const clickedLoadAll = await clickShowAllGamesButton();
            meta.clickedLoadAll = clickedLoadAll;

            if (clickedLoadAll) {
                console.log("🎯 'Alle Spiele laden' clicked. Scraping full history...");
                pageCount = 0;
                let hasPreviousPageFull = true;

                while (hasPreviousPageFull && pageCount < maxDeepPages) {
                    try {
                        pageCount++;
                        meta.pagesScrapedFull = pageCount;
                        console.log(`📄 Scraping full history page ${pageCount}...`);
                        const newMatches = scrapeMatchHistory();
                        allMatches = allMatches.concat(newMatches);
                        hasPreviousPageFull = await clickPreviousMatchPage();
                    } catch (pageError) {
                        console.error(`❌ Error on full history page ${pageCount}:`, pageError);
                        hasPreviousPageFull = await clickPreviousMatchPage();
                    }
                }

                if (!hasPreviousPageFull) {
                    meta.reachedHistoryStart = true;
                } else if (pageCount >= maxDeepPages) {
                    meta.stoppedReason = meta.stoppedReason || 'max_pages_reached';
                }
            }
        }

        allMatches = dedupeMatchesByHash(allMatches);

        const identityCheck = validateProfileIdentityAgainstMatches(expectedProfileName, allMatches);
        meta.profileName = expectedProfileName;
        meta.identityCheck = identityCheck;
        if (!identityCheck.valid) {
            meta.hadFatalError = true;
            meta.identityMismatch = true;
            meta.stoppedReason = 'profile_history_identity_mismatch';
            throw new Error(
                `Identity mismatch: profile "${expectedProfileName}" not found in ${identityCheck.mismatchRows}/${identityCheck.checkedRows} rows.`
            );
        }

        console.log(`🎉 Scraping completed. Total unique matches: ${allMatches.length}`);

        chrome.runtime.sendMessage({
            action: "fullMatchHistoryScraped",
            data: allMatches,
            meta
        });
        return { matches: allMatches, meta };
    } catch (error) {
        meta.hadFatalError = true;
        meta.stoppedReason = meta.stoppedReason || 'fatal_error';
        console.error("❌ Fatal error in scrapeFullMatchHistory:", error);
        console.error("Stack trace:", error.stack);

        chrome.runtime.sendMessage({
            action: "fullMatchHistoryScraped",
            data: [],
            meta,
            error: error.message
        });

        throw error;
    }
}

/**
 * Test function for hash consistency
 */
function testHashConsistency() {
    console.log('🧪 Testing hash consistency...');
    
    // Test 1: Same singles match from different perspectives
    const hash1 = generateUniversalMatchHash(
        'Frey, Anton', 21.6, 'Breuer, Korbinian', 22.6,
        '2021-07-30', 'BTV Schwaben 2021', '', '', '6:0 6:0'
    );
    
    const hash2 = generateUniversalMatchHash(
        'Breuer, Korbinian', 22.6, 'Frey, Anton', 21.6,
        '2021-07-30', 'BTV Schwaben 2021', '', '', '0:6 0:6'
    );
    
    console.log('Singles match hash 1:', hash1);
    console.log('Singles match hash 2:', hash2);
    console.log('✅ Singles hashes match:', hash1 === hash2);
    
    // Test 2: Same doubles match from different perspectives
    const hash3 = generateUniversalMatchHash(
        'Frey, Anton', 21.6, 'Schröder, Matteo', 21.6,
        '2021-07-30', 'BTV Schwaben 2021', 'Bader, Anton', 'Breuer, Korbinian', '6:2 6:3', '20.1', '19.8'
    );
    
    const hash4 = generateUniversalMatchHash(
        'Schröder, Matteo', 21.6, 'Frey, Anton', 21.6,
        '2021-07-30', 'BTV Schwaben 2021', 'Breuer, Korbinian', 'Bader, Anton', '2:6 3:6', '19.8', '20.1'
    );
    
    console.log('Doubles match hash 1:', hash3);
    console.log('Doubles match hash 2:', hash4);
    console.log('✅ Doubles hashes match:', hash3 === hash4);
    
    return {
        singlesMatch: hash1 === hash2,
        doublesMatch: hash3 === hash4
    };
}

// --- INITIALIZATION ---

// Set up navigation listeners immediately
setupNavigationListeners();

// Start observing on initial load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(startObservingPlayerData, 500);
    });
} else {
    // Document is already loaded
    setTimeout(startObservingPlayerData, 500);
}

// --- CLICK LISTENER ---
document.addEventListener('click', (event) => {
    const playerLink = event.target.closest('a.z-toolbarbutton');
    if (playerLink && playerLink.querySelector('.z-toolbarbutton-content')) {
        console.log("🔗 Player link clicked. Will handle via navigation listeners.");
    }
});

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "expGetCurrentPlayerIdentity") {
        sendResponse({
            success: true,
            data: getCurrentPlayerIdentitySnapshot()
        });
        return false;
    }

    if (request.action === "startFullHistoryScrape") {
        console.log("📥 Content script received startFullHistoryScrape message.");
        scrapeFullMatchHistory({
            mode: request.mode,
            latestKnownMatchDate: request.latestKnownMatchDate
        }).then(result => {
            sendResponse({
                status: "History scrape initiated",
                data: result.matches,
                meta: result.meta
            });
        }).catch(error => {
            console.error("❌ Error during full history scrape:", error);
            sendResponse({ status: "Error", message: error.message });
        });
        return true;
    }
    if (request.action === "scrapeCurrentPage") {
        console.log("📥 Content script received scrapeCurrentPage message.");
        startObservingPlayerData();
    }
});
