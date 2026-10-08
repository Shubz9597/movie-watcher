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

#endif
