#include "VLCSupport.h"
#include <math.h>
#include <dlfcn.h>
#include <stddef.h>

void torwatch_vlc_link_support(void) {}

TorWatchVideoLayout torwatch_video_layout(double viewport_width,
    double viewport_height, double video_aspect, int mode)
{
    TorWatchVideoLayout layout = {0, 0, 1, 1, 0};
    if (!isfinite(viewport_width) || !isfinite(viewport_height) ||
        !isfinite(video_aspect) || viewport_width <= 0 ||
        viewport_height <= 0 || video_aspect <= 0) return layout;

    layout.width = fmin(viewport_width, viewport_height * video_aspect);
    layout.height = layout.width / video_aspect;
    layout.viewport_width = viewport_width;
    if (mode == 1) {
        layout.scale_x = layout.scale_y = fmax(viewport_width / layout.width,
            viewport_height / layout.height);
    } else if (mode == 2 || mode == 3) {
        /* 2: stretched to at most 16:9; 3: stretched to the whole screen.
           Never cropped: the full picture stays visible, only widened. */
        layout.viewport_width = mode == 3 ? viewport_width
            : fmin(viewport_width, viewport_height * (16.0 / 9.0));
        layout.scale_x = layout.viewport_width / layout.width;
        layout.scale_y = viewport_height / layout.height;
    }
    return layout;
}

typedef void (*torwatch_subtitle_layout_fn)(int, int);

static torwatch_subtitle_layout_fn subtitle_layout(void)
{
    static int looked_up;
    static torwatch_subtitle_layout_fn fn;
    if (!looked_up) {
        fn = (torwatch_subtitle_layout_fn)dlsym(RTLD_DEFAULT, "libvlc_video_set_subtitle_layout");
        looked_up = 1;
    }
    return fn;
}

int torwatch_vlc_has_subtitle_layout(void)
{
    return subtitle_layout() != NULL;
}

void torwatch_vlc_set_subtitle_layout(int margin_permille, int text_scale)
{
    torwatch_subtitle_layout_fn fn = subtitle_layout();
    if (fn) fn(margin_permille, text_scale);
}
