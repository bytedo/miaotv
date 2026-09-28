/**
 * 快进快退同时保留控制栏与浮动按钮，由 CSS 在 768px 切换布局。
 * 配置共享同一状态，窗口缩放后仍使用最新秒数和单手布局。
 */
export default function artplayerPluginSeekButtons(option = {}) {
  return (art) => {
    const normalizeSeekTime = (value, fallback = 10) => {
      const seconds = Number(value);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
    };
    const normalizeLayout = (value) =>
      value === 'left' || value === 'right' ? value : 'both';

    let currentSeekTime = normalizeSeekTime(option.seekTime);
    let currentMobileLayout = normalizeLayout(option.mobileLayout);
    let destroyed = false;
    const player = art.template.$player;
    const previousLayout = player.getAttribute('data-seek-layout');
    const hadPluginClass = player.classList.contains(
      'artplayer-plugin-seek-buttons',
    );
    player.classList.add('artplayer-plugin-seek-buttons');

    const directions = [
      {
        name: 'seek-backward',
        index: 15,
        side: 'left',
        label: '后退',
        sign: -1,
        path: 'M16 4c6.627 0 12 5.373 12 12s-5.373 12-12 12S4 22.627 4 16h2.5c0 5.247 4.253 9.5 9.5 9.5s9.5-4.253 9.5-9.5S21.247 6.5 16 6.5c-2.858 0-5.42 1.265-7.176 3.265L12 13H4V5l2.94 2.94C9.303 5.39 12.453 4 16 4z',
      },
      {
        name: 'seek-forward',
        index: 16,
        side: 'right',
        label: '前进',
        sign: 1,
        path: 'M16 4C9.373 4 4 9.373 4 16s5.373 12 12 12 12-5.373 12-12h-2.5c0 5.247-4.253 9.5-9.5 9.5S6.5 21.247 6.5 16 10.753 6.5 16 6.5c2.858 0 5.42 1.265 7.176 3.265L20 13h8V5l-2.94 2.94C22.697 5.39 19.547 4 16 4z',
      },
    ];

    const getLabel = (direction) => `${direction.label} ${currentSeekTime} 秒`;
    const getIcon = (direction) => `
      <svg viewBox="0 0 32 32" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
        <path d="${direction.path}" fill="currentColor"/>
        <text x="16" y="19" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">${currentSeekTime}</text>
      </svg>`;

    const seek = (direction) => {
      if (destroyed || art.isLock) return;
      const nextTime = Math.max(
        0,
        art.currentTime + direction.sign * currentSeekTime,
      );
      art.seek = Number.isFinite(art.duration)
        ? Math.min(art.duration, nextTime)
        : nextTime;
      art.notice.show = getLabel(direction);
    };

    const controls = directions.map((direction) => {
      art.controls.add({
        name: direction.name,
        index: direction.index,
        position: 'left',
        html: getIcon(direction),
        tooltip: getLabel(direction),
        style: { width: '44px', height: '44px', padding: '8px' },
        mounted: (element) => {
          element.setAttribute('role', 'button');
          element.setAttribute('aria-label', getLabel(direction));
          element.tabIndex = 0;
          element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            seek(direction);
          });
        },
        click: () => seek(direction),
      });
      // ArtPlayer Controls.add 注册元素但不返回，须通过控件名读取。
      return art.controls[direction.name];
    });

    // 两个独立按钮也用于单手模式，避免按半个图标判定方向。
    const floatingButtons = directions.map((direction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `art-seek-floating-${direction.side}`;
      button.innerHTML = getIcon(direction);
      button.setAttribute('aria-label', getLabel(direction));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        seek(direction);
      });
      button.addEventListener('keydown', (event) => event.stopPropagation());
      player.appendChild(button);
      return button;
    });

    const updateVisibility = () => {
      if (destroyed) return;
      const visible = art.controls.show && !art.isLock;
      floatingButtons.forEach((button) => {
        button.hidden = !visible;
        button.disabled = !visible;
      });
    };

    const updateControls = () => {
      player.setAttribute('data-seek-layout', currentMobileLayout);
      directions.forEach((direction, index) => {
        for (const element of [controls[index], floatingButtons[index]]) {
          element.innerHTML = getIcon(direction);
          element.setAttribute('aria-label', getLabel(direction));
        }
      });
      updateVisibility();
    };

    art.on('ready', updateVisibility);
    art.on('control', updateVisibility);
    art.on('lock', updateVisibility);
    art.on('destroy', () => {
      destroyed = true;
      art.off('ready', updateVisibility);
      art.off('control', updateVisibility);
      art.off('lock', updateVisibility);
      floatingButtons.forEach((button) => button.remove());
      if (previousLayout === null) player.removeAttribute('data-seek-layout');
      else player.setAttribute('data-seek-layout', previousLayout);
      if (!hadPluginClass)
        player.classList.remove('artplayer-plugin-seek-buttons');
    });
    updateControls();

    return {
      name: 'artplayerPluginSeekButtons',
      config: (newOptions) => {
        if (destroyed) return;
        if (newOptions.seekTime !== undefined) {
          currentSeekTime = normalizeSeekTime(
            newOptions.seekTime,
            currentSeekTime,
          );
        }
        if (newOptions.mobileLayout !== undefined) {
          currentMobileLayout = normalizeLayout(newOptions.mobileLayout);
        }
        updateControls();
      },
    };
  };
}
