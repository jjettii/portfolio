document.addEventListener('DOMContentLoaded', function() {
    // ===== NAVIGATION ACTIVE STATE =====
    const navLinks = document.querySelectorAll('.nav-link');
    let currentPage = window.location.pathname.split('/').pop();

    // Handle root URL or trailing slash
    if (!currentPage || currentPage === '') {
        currentPage = 'index.html';
    }

    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage) {
            link.classList.add('active');
        }
    });

    // ===== VIDEO PREVIEW FUNCTIONALITY =====
    const videoGrid = document.querySelector('.video-grid');
    if (videoGrid) {
        const videoItems = document.querySelectorAll('.video-item');
        let currentlyPlaying = null;
        let touchStarted = false;

        // Project page mapping
        const projectPages = {
            'havn': 'projects/havn.html',
            'lightwater-cove': 'projects/lightwater-cove.html',
            'kwench': 'projects/kwench.html',
            'itl': 'projects/inside-the-leather.html',
            'san-poncho': 'projects/san-poncho.html',
            'bracelayer': 'projects/bracelayer.html',
            'plr': 'projects/plr.html',
            'den': 'projects/den.html',
            'edible-underwear': 'projects/edible-underwear.html',
            'arcteryx': 'projects/arcteryx.html',
            'green-acres': 'projects/green-acres.html',
            'peak-performance': 'projects/peak-performance.html',
            'sheringham': 'projects/sheringham.html',
            'whistlebuoy': 'projects/whistlebuoy.html',
            'anian': 'projects/anian.html',
            'therun': 'projects/the-run.html',
            'villamar': 'projects/villamar.html',
            'somedays': 'projects/somedays.html',
            'too-much': 'projects/too-much.html',
            'steam-mystic': 'projects/steam-mystic.html',
            'plezzy': 'projects/plezzy.html',
            'bear-cub': 'projects/bear-cub.html'
        };

        // Preload videos as they approach the viewport
        const preloadObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const video = entry.target.querySelector('.video-preview');
                    if (video && video.preload === 'none') {
                        video.preload = 'auto';
                        video.load();
                    }
                    preloadObserver.unobserve(entry.target);
                }
            });
        }, { rootMargin: '200px' });

        videoItems.forEach(item => preloadObserver.observe(item));

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
                    video.currentTime = 0; // Reset to beginning
                    item.classList.remove('playing');
                }
            });

            // Handle click for both desktop and mobile
            item.addEventListener('click', function(e) {
                e.preventDefault();

                // If video is not playing, this is mobile/touch - play it
                if (!item.classList.contains('playing')) {
                    // Pause and reset any currently playing video
                    if (currentlyPlaying && currentlyPlaying !== item) {
                        const prevVideo = currentlyPlaying.querySelector('.video-preview');
                        prevVideo.pause();
                        currentlyPlaying.classList.remove('playing');
                    }

                    // Play this video
                    video.play().catch(err => {
                        console.log('Video play failed:', err);
                    });
                    item.classList.add('playing');
                    currentlyPlaying = item;
                } else {
                    // Video is playing - navigate to individual project page
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
