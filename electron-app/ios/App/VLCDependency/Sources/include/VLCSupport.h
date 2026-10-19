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

// As torwatch_video_layout, for a picture whose real image is only the
// middle active_fraction (0..1] of the frame's height: black bars baked into
// the video (a 2.39:1 film released in a 16:9 frame). The bars fall outside
// the screen in both modes.
// mode 4 = picture: the real image as large as fits, in its true shape
//          (top to bottom on a phone, gaps at the sides);
// mode 3 = edge to edge: the real image reshaped to the whole screen, no
//          bars and nothing cut. Other modes as torwatch_video_layout.
TorWatchVideoLayout torwatch_video_layout_active(double viewport_width,
    double viewport_height, double video_aspect, int mode, double active_fraction);

#ifdef __OBJC__
#import <Foundation/Foundation.h>
// Asks a VLCMediaPlayer for a snapshot of the frame on screen (written to
// path; width or height 0 keeps the shape). NO instead of VLCKit's
// exception when there is no picture to take.
BOOL torwatch_save_snapshot(id _Nonnull player, NSString * _Nonnull path, int width, int height);
#endif

#endif
