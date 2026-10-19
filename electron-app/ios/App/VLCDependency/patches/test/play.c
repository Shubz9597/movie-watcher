/* Plays a video in real time through VLC's video output (subtitles drawn by
 * VLC as on the phone) and saves the displayed frame at set times, changing
 * the subtitle layout while playing like the app does. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <vlc/vlc.h>

#define W 1280
#define H 720
static unsigned char frame[W * H * 4];
static libvlc_media_player_t *player;
static const char *prefix;
static const int shots[] = { 5000, 15000, 25000, 35000 };
static int next_shot;

static void *lock(void *opaque, void **planes) { (void)opaque; planes[0] = frame; return NULL; }
static void unlock(void *opaque, void *picture, void *const *planes) { (void)opaque; (void)picture; (void)planes; }
static void display(void *opaque, void *picture)
{
    (void)opaque; (void)picture;
    if (next_shot >= 4) return;
    libvlc_time_t t = libvlc_media_player_get_time(player);
    if (t < shots[next_shot]) return;
    char name[256];
    snprintf(name, sizeof name, "%s_%d.ppm", prefix, shots[next_shot] / 1000);
    FILE *f = fopen(name, "wb");
    fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (int i = 0; i < W * H; i++) { /* RV32: B G R X */
        unsigned char rgb[3] = { frame[i * 4 + 2], frame[i * 4 + 1], frame[i * 4] };
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    next_shot++;
}

int main(int argc, char **argv)
{
    if (argc < 3) { fprintf(stderr, "play IN PREFIX [lift]\n"); return 2; }
    prefix = argv[2];
    const char *args[] = {
        "--no-audio", "--aout=adummy", "--quiet", "--no-osd",
        /* the app's options for plain-text subtitles: one box, no outline */
        "--freetype-font=DejaVu Sans Mono", "--freetype-color=16777215",
        "--freetype-background-opacity=153", "--freetype-background-color=0",
        "--freetype-outline-thickness=0", "--freetype-shadow-opacity=0",
        "--sub-text-scale=55", "--sub-track=0",
    };
    libvlc_instance_t *vlc = libvlc_new(sizeof args / sizeof *args, args);
    libvlc_media_t *media = libvlc_media_new_path(vlc, argv[1]);
    if (argc > 4) { /* a subtitle file, as the phone attaches downloads' and online ones */
        char option[512];
        snprintf(option, sizeof option, ":input-slave=file://%s", argv[4]);
        libvlc_media_slaves_add(media, libvlc_media_slave_type_subtitle, 4, strchr(option, '=') + 1);
    }
    player = libvlc_media_player_new_from_media(media);
    libvlc_media_release(media);
    libvlc_video_set_callbacks(player, lock, unlock, display, NULL);
    libvlc_video_set_format(player, "RV32", W, H, W * 4);
    int lift = argc > 3 ? atoi(argv[3]) : 0;
    /* 2: larger from the start; 3: larger and lifted from the start */
    libvlc_video_set_subtitle_layout(lift == 3 ? 150 : -1, (lift == 2 || lift == 3) ? 80 : 0);
    libvlc_media_player_play(player);
    int step = 0;
    while (next_shot < 4) {
        libvlc_time_t t = libvlc_media_player_get_time(player);
        if (lift == 1 && step == 0 && t >= 20000) { libvlc_video_set_subtitle_layout(150, 0); step = 1; fprintf(stderr, "lift at %lld\n", (long long)t); }
        if (lift == 4 && step == 0 && t >= 30000) { libvlc_video_set_subtitle_layout(-1, 80); step = 2; }
        if (lift == 1 && step == 1 && t >= 30000) { libvlc_video_set_subtitle_layout(150, 80); step = 2; fprintf(stderr, "bigger at %lld\n", (long long)t); }
        libvlc_state_t s = libvlc_media_player_get_state(player);
        if (s == libvlc_Ended || s == libvlc_Error) break;
        usleep(5000);
    }
    libvlc_media_player_stop(player);
    libvlc_media_player_release(player);
    libvlc_release(vlc);
    return 0;
}
