#ifndef TORWATCH_VLC_SUPPORT_H
#define TORWATCH_VLC_SUPPORT_H

void torwatch_vlc_link_support(void);

typedef struct {
    double width;
    double height;
    double scale_x;
    double scale_y;
} TorWatchVideoLayout;

// mode: 0 = fit, 1 = fill, 2 = stretch. The drawable's unscaled size stays
// identical between modes, so changing mode never rebuilds VLC's output.
TorWatchVideoLayout torwatch_video_layout(double viewport_width,
    double viewport_height, double video_aspect, int mode);

#endif
