#include "VLCSupport.h"
#include <math.h>

void torwatch_vlc_link_support(void) {}

TorWatchVideoLayout torwatch_video_layout(double viewport_width,
    double viewport_height, double video_aspect, int mode)
{
    TorWatchVideoLayout layout = {0, 0, 1, 1};
    if (!isfinite(viewport_width) || !isfinite(viewport_height) ||
        !isfinite(video_aspect) || viewport_width <= 0 ||
        viewport_height <= 0 || video_aspect <= 0) return layout;

    layout.width = fmin(viewport_width, viewport_height * video_aspect);
    layout.height = layout.width / video_aspect;
    if (mode == 1) {
        layout.scale_x = layout.scale_y = fmax(viewport_width / layout.width,
            viewport_height / layout.height);
    } else if (mode == 2) {
        layout.scale_x = viewport_width / layout.width;
        layout.scale_y = viewport_height / layout.height;
    }
    return layout;
}
