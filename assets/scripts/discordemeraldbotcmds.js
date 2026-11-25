function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

var cmdData = {
    utility: [
        { cmd: 'e!setbirthday',    desc: 'Set your birthday',              usage: 'e!setbirthday <dd/mm/yyyy | dd/mm>' },
        { cmd: 'e!removebirthday', desc: 'Remove your birthday',            usage: 'e!removebirthday' },
        { cmd: 'e!nextbirthday',   desc: 'Check whose birthday is next',    usage: 'e!nextbirthday' },
        { cmd: 'e!afk',            desc: 'Set AFK status',                  usage: 'e!afk [reason]' },
        { cmd: 'e!poll',           desc: 'Create a poll',                   usage: 'e!poll <question>' },
        { cmd: 'e!voiceprivate',   desc: 'Toggle voice private mode',       usage: 'e!voiceprivate' },
        { cmd: 'e!calc',           desc: 'Solve math problems',             usage: 'e!calc <expression>' },
        { cmd: 'e!ai',             desc: 'Chat with EmeraldBot',            usage: 'e!ai <prompt>' },
        { cmd: 'e!resetai',        desc: 'Reset EmeraldBot memories',       usage: 'e!resetai' }
    ],
    info: [
        { cmd: 'e!banwordlist',  desc: 'View the banned word list on user', usage: 'e!banwordlist <user>' },
        { cmd: 'e!help',         desc: 'Show help menu',                    usage: 'e!help' },
        { cmd: 'e!ping',         desc: "Check bot's latency",               usage: 'e!ping' },
        { cmd: 'e!roleinfo',     desc: 'Get details about a role',          usage: 'e!roleinfo <role>' },
        { cmd: 'e!serverinfo',   desc: 'Show server details',               usage: 'e!serverinfo' },
        { cmd: 'e!avatar',       desc: "Show a user's avatar",              usage: 'e!avatar [user]' },
        { cmd: 'e!userinfo',     desc: "View a user's information",         usage: 'e!userinfo [user]' }
    ],
    moderation: [
        { cmd: 'e!banworduser',   desc: 'Ban users from saying specific words.', usage: 'e!banworduser <user> <bannedword>' },
        { cmd: 'e!unbanworduser', desc: 'Allow banned words again.',             usage: 'e!unbanworduser <user>' },
        { cmd: 'e!renamerole',    desc: 'Rename a role.',                        usage: 'e!renamerole <role> <newname>' },
        { cmd: 'e!autorole',      desc: 'Assign roles to new members.',          usage: 'e!autorole <enable | disable> <role>' },
        { cmd: 'e!mute',          desc: 'Mute a user.',                          usage: 'e!mute <user> [reason]' },
        { cmd: 'e!unmute',        desc: 'Unmute a user.',                        usage: 'e!unmute <user>' },
        { cmd: 'e!chatmod',       desc: 'Toggle chat moderation.',               usage: 'e!chatmod' },
        { cmd: 'e!voicekick',     desc: 'Kick a user from voice channels.',      usage: 'e!voicekick <user>' },
        { cmd: 'e!purge',         desc: 'Delete multiple messages.',             usage: 'e!purge <amount>' },
        { cmd: 'e!voicelock',     desc: 'Lock voice channels.',                  usage: 'e!voicelock' },
        { cmd: 'e!chatlock',      desc: 'Lock text channels.',                   usage: 'e!chatlock' },
        { cmd: 'e!log',           desc: 'Log server events.',                    usage: 'e!log <enable | disable> <channel>' },
        { cmd: 'e!joinleave',     desc: 'Create welcome and goodbye messages.',  usage: 'e!joinleave <enable | disable> <channel>' }
    ],
    fun: [
        { cmd: 'e!coinflip', desc: 'Flip a coin.',               usage: 'e!coinflip' },
        { cmd: 'e!dice',     desc: 'Roll a six-sided dice.',      usage: 'e!dice' },
        { cmd: 'e!say',      desc: 'Repeat your message.',        usage: 'e!say <text>' },
        { cmd: 'e!rps',      desc: 'Play rock-paper-scissors.',   usage: 'e!rps' }
    ],
    music: [
        { cmd: 'e!play',       desc: 'Play a song or playlist.',                  usage: 'e!play <query | url>' },
        { cmd: 'e!skip',       desc: 'Skip the current song or multiple songs.',  usage: 'e!skip [amount]' },
        { cmd: 'e!stop',       desc: 'Stop playback and clear the queue.',        usage: 'e!stop' },
        { cmd: 'e!pause',      desc: 'Pause the current playback.',               usage: 'e!pause' },
        { cmd: 'e!resume',     desc: 'Resume the paused song.',                   usage: 'e!resume' },
        { cmd: 'e!queue',      desc: 'Show the current music queue.',             usage: 'e!queue [page]' },
        { cmd: 'e!repeat',     desc: 'Set repeat mode.',                          usage: 'e!repeat <off | on | all>' },
        { cmd: 'e!nowplaying', desc: 'Display the currently playing track.',      usage: 'e!nowplaying' }
    ]
};

var currentCat = 'utility';
var indicator = null;

function moveIndicator(tabEl) {
    if (!indicator || !tabEl) return;
    var tabsEl = tabEl.closest('.cmd-tabs');
    var tabRect  = tabEl.getBoundingClientRect();
    var tabsRect = tabsEl.getBoundingClientRect();
    var indicatorWidth = 32;
    var center = tabRect.left - tabsRect.left + tabRect.width / 2;
    indicator.style.left = (center - indicatorWidth / 2) + 'px';
}

function renderCards(list) {
    var grid = document.getElementById('cmdCardGrid');
    if (!list || list.length === 0) {
        grid.innerHTML = '<div class="cmd-no-results">No commands found.</div>';
        return;
    }
    grid.innerHTML = list.map(function (c, i) {
        var delay = (i * 28).toFixed(0);
        return '<div class="cmd-card" style="animation-delay:' + delay + 'ms">' +
            '<div class="cmd-card-name">'  + escapeHtml(c.cmd)   + '</div>' +
            '<div class="cmd-card-desc">'  + escapeHtml(c.desc)  + '</div>' +
            '<div class="cmd-card-usage">' + escapeHtml(c.usage) + '</div>' +
            '</div>';
    }).join('');
}

function showCategory(cat, skipAnimation) {
    var grid = document.getElementById('cmdCardGrid');

    var newActiveTab = null;
    document.querySelectorAll('.cmd-tab').forEach(function (btn) {
        var isActive = btn.textContent.trim().toLowerCase() === cat;
        btn.classList.toggle('active', isActive);
        if (isActive) newActiveTab = btn;
    });

    moveIndicator(newActiveTab);

    currentCat = cat;
    document.getElementById('cmdSearch').value = '';
    history.replaceState(null, '', '#' + cat);

    if (skipAnimation || !grid.children.length) {
        renderCards(cmdData[cat]);
        return;
    }

    grid.classList.add('is-exiting');
    setTimeout(function () {
        grid.classList.remove('is-exiting');
        renderCards(cmdData[cat]);
    }, 150);
}

function filterCards(query) {
    var q = query.toLowerCase();
    if (!q) { renderCards(cmdData[currentCat]); return; }
    var filtered = cmdData[currentCat].filter(function (c) {
        return c.cmd.toLowerCase().indexOf(q)   !== -1 ||
               c.desc.toLowerCase().indexOf(q)  !== -1 ||
               c.usage.toLowerCase().indexOf(q) !== -1;
    });
    renderCards(filtered);
}

window.addEventListener('DOMContentLoaded', function () {
    var tabsEl = document.querySelector('.cmd-tabs');

    indicator = document.createElement('div');
    indicator.className = 'cmd-tab-indicator';
    tabsEl.appendChild(indicator);

    var hash  = window.location.hash.replace('#', '').toLowerCase();
    var valid = ['utility', 'info', 'moderation', 'fun', 'music'];
    var initCat = valid.indexOf(hash) !== -1 ? hash : 'utility';

    indicator.style.transition = 'none';
    showCategory(initCat, true);

    // Re-measure once fonts have loaded so the indicator is perfectly
    // centered on the active tab on first load. font-display: swap causes
    // the tab text to reflow after the initial paint, which shifts the
    // pill if measured too early.
    function centerIndicator() {
        var activeTab = document.querySelector('.cmd-tab.active');
        if (activeTab) moveIndicator(activeTab);
    }

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(centerIndicator);
    } else {
        requestAnimationFrame(centerIndicator);
    }

    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            indicator.style.transition = '';
        });
    });

    window.addEventListener('resize', function () {
        var activeTab = document.querySelector('.cmd-tab.active');
        if (activeTab) moveIndicator(activeTab);
    });
});