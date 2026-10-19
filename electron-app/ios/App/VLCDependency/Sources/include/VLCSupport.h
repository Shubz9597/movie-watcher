#ifndef TORWATCH_VLC_SUPPORT_H
#define TORWATCH_VLC_SUPPORT_H

void torwatch_vlc_link_support(void);

typedef struct {
    double width;
    double height;
    double scale_x;
    double scale_y;
    double viewport_width;
} TorWatchVideoLayout;

// mode: 0 = fit, 1 = fill, 2 = stretch. The drawable's unscaled size stays
// identical between modes, so changing mode never rebuilds VLC's output.
// Stretch uses a viewport no wider than 16:9, retaining centered side bars
// on ultrawide phones. Pass the width available after horizontal safe insets.
TorWatchVideoLayout torwatch_video_layout(double viewport_width,
    double viewport_height, double video_aspect, int mode);

// TorWatch's patched MobileVLCKit (npm run build:ios-vlc) draws dialogue
// subtitles in the box itself and moves/resizes them while playing. Looked
// up at run time: the official framework lacks it, and then this reports 0
// and the setter does nothing.
int torwatch_vlc_has_subtitle_layout(void);
// margin_permille: lift in thousandths of the picture height (negative:
// none); text_scale: percent of the default size (0: the player option).
void torwatch_vlc_set_subtitle_layout(int margin_permille, int text_scale);

#endif
