// Page navigation system
document.addEventListener('DOMContentLoaded', function() {
    const navLinks = document.querySelectorAll('.nav-link, .logo');
    const pages = document.querySelectorAll('.page');

    // Function to show a specific page
    function showPage(pageName) {
        // Hide all pages
        pages.forEach(page => {
            page.classList.remove('active');
        });

        // Show the selected page
        const targetPage = document.getElementById(`${pageName}-page`);
        if (targetPage) {
            targetPage.classList.add('active');
        }

        // Update active nav link
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.dataset.page === pageName) {
                link.classList.add('active');
            }
        });

        // Scroll to top of content
        document.querySelector('.content').scrollTop = 0;
    }

    // Add click event to all nav links
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const pageName = this.dataset.page;
            showPage(pageName);
            
            // Update URL hash without jumping
            history.pushState(null, null, `#${pageName}`);
        });
    });

    // Handle browser back/forward buttons
    window.addEventListener('popstate', function() {
        const hash = window.location.hash.replace('#', '') || 'home';
        showPage(hash);
    });

    // Show correct page on initial load based on URL hash
    const initialHash = window.location.hash.replace('#', '') || 'home';
    showPage(initialHash);

    // Video grid hover/tap preview functionality
    const videoItems = document.querySelectorAll('.video-item');
    let currentlyPlaying = null;
    let touchStarted = false;

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
                // Video is playing - navigate to reel
                showPage('reel');
                history.pushState(null, null, '#reel');
            }
        });

        // Detect touch to disable hover behavior on touch devices
        item.addEventListener('touchstart', function() {
            touchStarted = true;
        });
    });
});
