/**
 * Chromecast Integration for Youtube2Podcast
 * 
 * Enables casting audio to Chromecast and compatible devices.
 * Uses the Google Cast SDK (CAF - Cast Application Framework)
 */

(function() {
    'use strict';

    // Configuration
    const CAST_APP_ID = chrome.cast ? chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID : 'CC1AD845';
    const DEBUG = false;

    // State
    let castContext = null;
    let castSession = null;
    let currentMediaSession = null;
    let currentAudioPlayer = null;
    let isCastConnected = false;
    let pendingSeek = null;

    // DOM Elements
    const castBtn = document.getElementById('cast-btn');

    /**
     * Initialize the Cast SDK
     */
    function initializeCast() {
        // Check if Cast SDK is available
        if (typeof cast === 'undefined' || typeof chrome === 'undefined' || !chrome.cast) {
            log('Cast SDK not available');
            return;
        }

        // Wait for Cast API to be ready
        window['__onGCastApiAvailable'] = function(isAvailable) {
            if (isAvailable) {
                initializeCastApi();
            } else {
                log('Cast API not available');
            }
        };

        // If already loaded
        if (window.cast && window.cast.framework) {
            initializeCastApi();
        }
    }

    /**
     * Initialize the Cast API after it's available
     */
    function initializeCastApi() {
        try {
            castContext = cast.framework.CastContext.getInstance();
            
            castContext.setOptions({
                receiverApplicationId: CAST_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
            });

            // Listen for Cast state changes
            castContext.addEventListener(
                cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                handleSessionStateChanged
            );

            castContext.addEventListener(
                cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                handleCastStateChanged
            );

            // Show the cast button
            showCastButton();
            log('Cast API initialized');
        } catch (error) {
            console.error('Error initializing Cast API:', error);
        }
    }

    /**
     * Handle Cast state changes (device availability)
     */
    function handleCastStateChanged(event) {
        log('Cast state changed:', event.castState);
        
        switch (event.castState) {
            case cast.framework.CastState.NO_DEVICES_AVAILABLE:
                hideCastButton();
                break;
            case cast.framework.CastState.NOT_CONNECTED:
            case cast.framework.CastState.CONNECTING:
            case cast.framework.CastState.CONNECTED:
                showCastButton();
                break;
        }
        
        updateCastButtonState(event.castState);
    }

    /**
     * Handle session state changes
     */
    function handleSessionStateChanged(event) {
        log('Session state changed:', event.sessionState);
        
        switch (event.sessionState) {
            case cast.framework.SessionState.SESSION_STARTED:
            case cast.framework.SessionState.SESSION_RESUMED:
                castSession = castContext.getCurrentSession();
                isCastConnected = true;
                onSessionConnected();
                break;
            case cast.framework.SessionState.SESSION_ENDED:
                castSession = null;
                currentMediaSession = null;
                isCastConnected = false;
                onSessionDisconnected();
                break;
        }
    }

    /**
     * Called when a Cast session is connected
     */
    function onSessionConnected() {
        log('Cast session connected');
        updateCastButtonState(cast.framework.CastState.CONNECTED);
        
        // If there's a currently playing audio, cast it
        if (currentAudioPlayer) {
            const audio = currentAudioPlayer.querySelector('audio');
            if (audio && !audio.paused) {
                castCurrentAudio();
            }
        }
        
        showToast('Conectado a ' + castSession.getCastDevice().friendlyName, 'success');
    }

    /**
     * Called when a Cast session is disconnected
     */
    function onSessionDisconnected() {
        log('Cast session disconnected');
        updateCastButtonState(cast.framework.CastState.NOT_CONNECTED);
        showToast('Desconectado del dispositivo', 'info');
    }

    /**
     * Show the cast button
     */
    function showCastButton() {
        if (castBtn) {
            castBtn.classList.remove('hidden');
        }
    }

    /**
     * Hide the cast button
     */
    function hideCastButton() {
        if (castBtn) {
            castBtn.classList.add('hidden');
        }
    }

    /**
     * Update cast button visual state
     */
    function updateCastButtonState(state) {
        if (!castBtn) return;
        
        castBtn.classList.remove('connected', 'connecting');
        
        switch (state) {
            case cast.framework.CastState.CONNECTED:
                castBtn.classList.add('connected');
                castBtn.title = 'Desconectar dispositivo';
                break;
            case cast.framework.CastState.CONNECTING:
                castBtn.classList.add('connecting');
                castBtn.title = 'Conectando...';
                break;
            default:
                castBtn.title = 'Transmitir a dispositivo';
        }
    }

    /**
     * Request a Cast session (open device picker)
     */
    function requestCastSession() {
        if (!castContext) {
            log('Cast context not available');
            return;
        }

        if (isCastConnected) {
            // End session
            castContext.endCurrentSession(true);
        } else {
            // Request session (shows device picker)
            castContext.requestSession()
                .then(function() {
                    log('Session request successful');
                })
                .catch(function(error) {
                    if (error !== 'cancel') {
                        console.error('Session request error:', error);
                        showToast('Error al conectar con el dispositivo', 'error');
                    }
                });
        }
    }

    /**
     * Cast the currently playing audio
     */
    function castCurrentAudio() {
        if (!isCastConnected || !castSession || !currentAudioPlayer) {
            log('Cannot cast: no session or audio player');
            return;
        }

        const audio = currentAudioPlayer.querySelector('audio');
        const source = audio.querySelector('source');
        if (!source) return;

        // Build absolute URL for the audio file
        const audioUrl = new URL(source.src, window.location.origin).href;
        
        // Get episode title from card
        const card = currentAudioPlayer.closest('.episode-card, .community-card, .masonry-item');
        const titleEl = card ? card.querySelector('.episode-title, .title') : null;
        const title = titleEl ? titleEl.textContent.trim() : 'Youtube2Podcast';

        // Get thumbnail
        const thumbnailEl = card ? card.querySelector('.aspect-video img, .thumbnail') : null;
        const thumbnailUrl = thumbnailEl ? thumbnailEl.src : null;

        loadMedia(audioUrl, title, thumbnailUrl, audio.currentTime);
    }

    /**
     * Load media on the Cast device
     */
    function loadMedia(url, title, thumbnailUrl, startTime) {
        if (!castSession) {
            log('No cast session');
            return;
        }

        const mediaInfo = new chrome.cast.media.MediaInfo(url, 'audio/mpeg');
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = title;
        mediaInfo.metadata.artist = 'Youtube2Podcast';
        
        if (thumbnailUrl) {
            mediaInfo.metadata.images = [
                new chrome.cast.Image(thumbnailUrl)
            ];
        }

        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.currentTime = startTime || 0;
        request.autoplay = true;

        castSession.loadMedia(request)
            .then(function() {
                log('Media loaded successfully');
                currentMediaSession = castSession.getMediaSession();
                setupMediaSessionListeners();
                
                // Pause local audio
                pauseLocalAudio();
            })
            .catch(function(error) {
                console.error('Error loading media:', error);
                showToast('Error al reproducir en el dispositivo', 'error');
            });
    }

    /**
     * Setup listeners for media session events
     */
    function setupMediaSessionListeners() {
        if (!currentMediaSession) return;

        currentMediaSession.addUpdateListener(function(isAlive) {
            if (!isAlive) {
                currentMediaSession = null;
                return;
            }

            // Sync local player state with cast state
            syncLocalPlayerState();
        });
    }

    /**
     * Sync local player UI with Cast player state
     */
    function syncLocalPlayerState() {
        if (!currentMediaSession || !currentAudioPlayer) return;

        const playerState = currentMediaSession.playerState;
        const playIcon = currentAudioPlayer.querySelector('.play-icon');
        const pauseIcon = currentAudioPlayer.querySelector('.pause-icon');
        const progressFill = currentAudioPlayer.querySelector('.audio-progress-fill');
        const progressBar = currentAudioPlayer.querySelector('.audio-progress');
        const timeDisplay = currentAudioPlayer.querySelector('.audio-time');

        // Update play/pause icons
        if (playerState === chrome.cast.media.PlayerState.PLAYING) {
            currentAudioPlayer.classList.add('playing');
            if (playIcon) playIcon.classList.add('hidden');
            if (pauseIcon) pauseIcon.classList.remove('hidden');
        } else {
            currentAudioPlayer.classList.remove('playing');
            if (playIcon) playIcon.classList.remove('hidden');
            if (pauseIcon) pauseIcon.classList.add('hidden');
        }

        // Update progress
        const currentTime = currentMediaSession.getEstimatedTime();
        const duration = currentMediaSession.media.duration;
        
        if (duration && duration > 0) {
            const percent = (currentTime / duration) * 100;
            if (progressFill) progressFill.style.width = percent + '%';
            if (progressBar) progressBar.value = percent;
            if (timeDisplay) timeDisplay.textContent = formatTime(currentTime);
        }
    }

    /**
     * Pause local audio playback
     */
    function pauseLocalAudio() {
        if (!currentAudioPlayer) return;
        
        const audio = currentAudioPlayer.querySelector('audio');
        if (audio && !audio.paused) {
            audio.pause();
        }
    }

    /**
     * Play/Pause on Cast device
     */
    function toggleCastPlayback() {
        if (!currentMediaSession) return;

        const playerState = currentMediaSession.playerState;
        
        if (playerState === chrome.cast.media.PlayerState.PLAYING) {
            currentMediaSession.pause(
                new chrome.cast.media.PauseRequest(),
                function() { log('Paused'); },
                function(error) { console.error('Pause error:', error); }
            );
        } else {
            currentMediaSession.play(
                new chrome.cast.media.PlayRequest(),
                function() { log('Playing'); },
                function(error) { console.error('Play error:', error); }
            );
        }
    }

    /**
     * Seek on Cast device
     */
    function seekCast(time) {
        if (!currentMediaSession) return;

        const request = new chrome.cast.media.SeekRequest();
        request.currentTime = time;

        currentMediaSession.seek(request,
            function() { log('Seeked to ' + time); },
            function(error) { console.error('Seek error:', error); }
        );
    }

    /**
     * Format time in m:ss
     */
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return mins + ':' + secs.toString().padStart(2, '0');
    }

    /**
     * Show toast notification
     */
    function showToast(message, type) {
        // Use the app's existing showToast if available
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }

        const toast = document.createElement('div');
        const bgColor = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-blue-600';
        toast.className = 'fixed bottom-4 left-1/2 transform -translate-x-1/2 ' + bgColor + ' text-white px-6 py-3 rounded-lg shadow-lg z-[10000] flex items-center gap-2';
        toast.innerHTML = '<i class="bi bi-cast"></i> ' + message;
        document.body.appendChild(toast);
        
        setTimeout(function() {
            toast.style.transition = 'opacity 0.5s';
            toast.style.opacity = '0';
            setTimeout(function() { toast.remove(); }, 500);
        }, 3000);
    }

    /**
     * Debug logging
     */
    function log() {
        if (DEBUG) {
            console.log.apply(console, ['[Cast]'].concat(Array.prototype.slice.call(arguments)));
        }
    }

    /**
     * Intercept audio player play events
     */
    function interceptAudioPlayers() {
        // Use MutationObserver to catch dynamically added players
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) {
                        const players = node.querySelectorAll ? node.querySelectorAll('.custom-audio-player') : [];
                        players.forEach(setupPlayerIntercept);
                        
                        if (node.classList && node.classList.contains('custom-audio-player')) {
                            setupPlayerIntercept(node);
                        }
                    }
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Setup existing players
        document.querySelectorAll('.custom-audio-player').forEach(setupPlayerIntercept);
    }

    /**
     * Setup intercept for a single audio player
     */
    function setupPlayerIntercept(player) {
        if (player.dataset.castIntercepted) return;
        player.dataset.castIntercepted = 'true';

        const playBtn = player.querySelector('.audio-play-btn');
        const progressBar = player.querySelector('.audio-progress');
        const audio = player.querySelector('audio');

        if (!playBtn || !audio) return;

        // Intercept play button
        playBtn.addEventListener('click', function(e) {
            currentAudioPlayer = player;

            // If casting, control Cast instead of local
            if (isCastConnected && currentMediaSession) {
                e.preventDefault();
                e.stopPropagation();
                toggleCastPlayback();
                return false;
            }

            // If connected but no media session, cast current audio
            if (isCastConnected && !currentMediaSession) {
                // Let the normal play happen, then cast
                setTimeout(function() {
                    castCurrentAudio();
                }, 100);
            }
        }, true);

        // Intercept seek
        if (progressBar) {
            progressBar.addEventListener('input', function(e) {
                if (isCastConnected && currentMediaSession) {
                    const percent = e.target.value;
                    const duration = currentMediaSession.media ? currentMediaSession.media.duration : 0;
                    if (duration > 0) {
                        const seekTime = (percent / 100) * duration;
                        seekCast(seekTime);
                    }
                }
            });
        }

        // Track when audio starts playing
        audio.addEventListener('play', function() {
            currentAudioPlayer = player;
            
            // If casting, automatically send to Cast
            if (isCastConnected && !currentMediaSession) {
                setTimeout(function() {
                    castCurrentAudio();
                }, 100);
            }
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            initializeCast();
            interceptAudioPlayers();
            
            // Cast button click handler
            if (castBtn) {
                castBtn.addEventListener('click', requestCastSession);
            }
        });
    } else {
        initializeCast();
        interceptAudioPlayers();
        
        if (castBtn) {
            castBtn.addEventListener('click', requestCastSession);
        }
    }

    // Expose for debugging
    window.Y2PCast = {
        requestSession: requestCastSession,
        isConnected: function() { return isCastConnected; },
        castCurrentAudio: castCurrentAudio
    };

})();
