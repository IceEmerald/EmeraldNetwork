 const SENSITIVITY = 0.15; 
 const FRICTION = 0.85;  
 const MIN_VELOCITY = 0.1; 
 let currentScrollY = window.pageYOffset; 
 let velocityY = 0; 
 let isWheeling = false; 
 let animationFrameId = null; 
 function smoothScroll() {
     currentScrollY += velocityY;
     velocityY *= FRICTION;
     const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
     currentScrollY = Math.max(0, Math.min(currentScrollY, maxScroll));
     window.scrollTo(0, currentScrollY);
     if (Math.abs(velocityY) > MIN_VELOCITY) {
         animationFrameId = requestAnimationFrame(smoothScroll);
     } else {
         velocityY = 0;
         isWheeling = false;
         animationFrameId = null;
     }
 }
 window.addEventListener('wheel', function(event) {
     // Let controls and nested scroll areas (such as menus or text panels)
     // keep their native wheel behavior. Everything else scrolls the page.
     const scrollable = event.target instanceof Element
         ? event.target.closest('[data-native-wheel], textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"]')
         : null;
     if (scrollable) return;

     let ancestor = event.target instanceof Element ? event.target.parentElement : null;
     while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
         const style = window.getComputedStyle(ancestor);
         const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY)
             && ancestor.scrollHeight > ancestor.clientHeight;
         if (canScrollY) {
             const canMoveDown = event.deltaY > 0 && ancestor.scrollTop + ancestor.clientHeight < ancestor.scrollHeight;
             const canMoveUp = event.deltaY < 0 && ancestor.scrollTop > 0;
             if (canMoveDown || canMoveUp) return;
         }
         ancestor = ancestor.parentElement;
     }

     event.preventDefault();
     if (!isWheeling || animationFrameId === null) {
          currentScrollY = window.pageYOffset;
     }
     isWheeling = true;
     velocityY += event.deltaY * SENSITIVITY;
     velocityY = Math.max(-150, Math.min(velocityY, 150));
     if (!animationFrameId) {
         animationFrameId = requestAnimationFrame(smoothScroll);
     }
 }, { passive: false });
 window.addEventListener('load', () => {
     currentScrollY = window.pageYOffset;
 });
 window.addEventListener('resize', () => {
     currentScrollY = window.pageYOffset; 
     if (animationFrameId) {
         cancelAnimationFrame(animationFrameId);
         animationFrameId = null;
     }
     velocityY = 0;
     isWheeling = false;
 });
