#import "VLCSupport.h"

// VLCKit raises an Objective-C exception when it cannot take a snapshot (no
// video output yet, or none within half a second); Swift cannot catch those.
@protocol TorWatchSnapshotting
- (void)saveVideoSnapshotAt:(NSString *)path withWidth:(int)width andHeight:(int)height;
@end

BOOL torwatch_save_snapshot(id player, NSString *path, int width, int height)
{
    @try {
        [(id<TorWatchSnapshotting>)player saveVideoSnapshotAt:path withWidth:width andHeight:height];
        return YES;
    } @catch (NSException *exception) {
        return NO;
    }
}
