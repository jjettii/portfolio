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
});
