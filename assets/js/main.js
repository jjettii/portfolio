document.addEventListener('DOMContentLoaded', function() {
    // ===== NAVIGATION ACTIVE STATE =====
    const navLinks = document.querySelectorAll('.nav-link');
    // Normalize: strip trailing slash from pathname so /about/ and /about both match.
    // The empty string after stripping / becomes '/' (root).
    const currentPath = window.location.pathname.replace(/\/$/, '') || '/';

    navLinks.forEach(link => {
        const href = (link.getAttribute('href') || '').replace(/\/$/, '') || '/';
        if (href === currentPath) {
            link.classList.add('active');
        }
    });

    // ===== VIDEO PREVIEW FUNCTIONALITY =====
    const videoGrid = document.querySelector('.video-grid');
    if (videoGrid) {
        const videoItems = document.querySelectorAll('.video-item');
        let currentlyPlaying = null;
        let touchStarted = false;

        // Maps data-video-id values to root-absolute clean URLs used for navigation
        // when a user clicks a playing video on the portfolio grid.
        const projectPages = {
            'havn': '/projects/havn/',
            'lightwater-cove': '/projects/lightwater-cove/',
            'kwench': '/projects/kwench/',
            'itl': '/projects/inside-the-leather/',
            'san-poncho': '/projects/san-poncho/',
            'bracelayer': '/projects/bracelayer/',
            'plr': '/projects/plr/',
            'den': '/projects/den/',
            'edible-underwear': '/projects/edible-underwear/',
            'arcteryx': '/projects/arcteryx/',
            'green-acres': '/projects/green-acres/',
            'peak-performance': '/projects/peak-performance/',
            'sheringham': '/projects/sheringham/',
            'whistlebuoy': '/projects/whistlebuoy/',
            'anian': '/projects/anian/',
            'therun': '/projects/the-run/',
            'villamar': '/projects/villamar/',
            'somedays': '/projects/somedays/',
            'too-much': '/projects/too-much/',
            'steam-mystic': '/projects/steam-mystic/',
            'plezzy': '/projects/plezzy/',
            'bear-cub': '/projects/bear-cub/'
        };

        videoItems.forEach(item => {
            const video = item.querySelector('.video-preview');
            const videoId = item.dataset.videoId;

            // Desktop: hover to preview
            item.addEventListener('mouseenter', function() {
                if (!touchStarted) {
                    video.play().catch(err => {
                        console.log('Video play failed:', err);
                    });
                    item.classList.add('playing');
                }
            });

            item.addEventListener('mouseleave', function() {
                if (!touchStarted) {
                    video.pause();
                    video.currentTime = 0;
                    item.classList.remove('playing');
                }
            });

            // Handle click for both desktop and mobile
            item.addEventListener('click', function(e) {
                e.preventDefault();

                if (!item.classList.contains('playing')) {
                    // Pause and reset any currently playing video
                    if (currentlyPlaying && currentlyPlaying !== item) {
                        const prevVideo = currentlyPlaying.querySelector('.video-preview');
                        prevVideo.pause();
                        prevVideo.currentTime = 0;
                        currentlyPlaying.classList.remove('playing');
                    }

                    // load() forces Safari to re-evaluate sources and bind
                    // the play action to the user gesture synchronously
                    video.load();
                    video.play().catch(err => {
                        console.log('Video play failed:', err);
                    });
                    item.classList.add('playing');
                    currentlyPlaying = item;
                } else {
                    // Video is playing — navigate to project page
                    const targetPage = projectPages[videoId];
                    if (targetPage) {
                        window.location.href = targetPage;
                    }
                }
            });

            // Detect touch to disable hover behavior on touch devices
            item.addEventListener('touchstart', function() {
                touchStarted = true;
            });
        });
    }
});