// CGVirtualDisplay is a private macOS API. Runtime checked; never required for mirroring.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
@protocol ReachVirtualDisplay <NSObject>
- (instancetype)initWithDescriptor:(id)descriptor;
- (instancetype)initWithWidth:(unsigned)width height:(unsigned)height refreshRate:(double)rate;
- (BOOL)applySettings:(id)settings;
- (unsigned)displayID;
@end

static void emit(NSDictionary *value) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);
}
@interface Session : NSObject
@property(strong) id display;
@property(strong) NSStatusItem *item;
@property(strong) NSMenuItem *label;
@property(strong) NSDate *last;
@property BOOL disconnected;
@property BOOL ending;
@end
@implementation Session
-(void)finish {
    if(self.ending)return;self.ending=YES;
    BOOL hadDisplay=self.display!=nil;
    self.display=nil;
    // WindowServer can defer virtual-display removal while physical displays
    // sleep. A bounded user-activity assertion lets it complete; no power or
    // lock setting is changed, and this cannot unlock the login window.
    if(hadDisplay) {
        IOPMAssertionID wake=kIOPMNullAssertionID;
        if(IOPMAssertionDeclareUserActivity(CFSTR("Reach virtual display cleanup"),kIOPMUserActiveLocal,&wake)==kIOReturnSuccess) {
            IOPMAssertionSetProperty(wake,kIOPMAssertionTimeoutKey,(__bridge CFTypeRef)@2);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC),dispatch_get_main_queue(),^{IOPMAssertionRelease(wake);});
        }
    }
    if(self.item)[[NSStatusBar systemStatusBar] removeStatusItem:self.item];self.item=nil;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
        [NSApp stop:nil];
        [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:YES];
    });
}
-(void)disconnect:(id)sender { self.disconnected=YES;emit(@{@"type":@"disconnect"});[self finish]; }
-(void)watch:(NSTimer*)timer { if (-[self.last timeIntervalSinceNow]>8) [self finish]; }
@end
int main(int argc,const char *argv[]) { @autoreleasepool {
    BOOL available=NSClassFromString(@"CGVirtualDisplay") && NSClassFromString(@"CGVirtualDisplayDescriptor") && NSClassFromString(@"CGVirtualDisplayMode") && NSClassFromString(@"CGVirtualDisplaySettings");
    CGDirectDisplayID online[32];uint32_t count=0;BOOL headless=YES;
    if(CGGetOnlineDisplayList(32,online,&count)==kCGErrorSuccess) for(uint32_t i=0;i<count;i++) if(CGDisplayModelNumber(online[i])!=0x76697274) headless=NO;
    if (argc>1 && strcmp(argv[1],"--probe")==0) {emit(@{@"available":@(available),@"experimental":@YES,@"headless":@(headless)});return 0;}
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    Session *s=[Session new];s.last=[NSDate date];
    BOOL match=headless || (argc>1 && strcmp(argv[1],"match")==0);
    CGDirectDisplayID displayID=CGMainDisplayID();
    @try {
        if (match) { @autoreleasepool {
            if (!available || argc<4) @throw [NSException exceptionWithName:@"Unavailable" reason:@"Virtual displays are unavailable on this Mac. Connect an HDMI dummy plug and choose Mirror main display." userInfo:nil];
            int width=atoi(argv[2]),height=atoi(argv[3]);
            if(width<640||height<640||width>3840||height>3840||(long)width*height>9000000) return 1;
            id descriptor=[NSClassFromString(@"CGVirtualDisplayDescriptor") new];
            [descriptor setValue:@"Reach iPad" forKey:@"name"];
            [descriptor setValue:@(width) forKey:@"maxPixelsWide"];[descriptor setValue:@(height) forKey:@"maxPixelsHigh"];
            [descriptor setValue:@(0x5243) forKey:@"vendorID"];[descriptor setValue:@(0x76697274) forKey:@"productID"];
            NSNumber *serial=@(arc4random_uniform(0x7ffffffe)+1);
            [descriptor setValue:serial forKey:@"serialNum"];
            if([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")]) [descriptor setValue:serial forKey:@"serialNumber"];
            [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.64,0.33)] forKey:@"redPrimary"];
            [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.30,0.60)] forKey:@"greenPrimary"];
            [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.15,0.06)] forKey:@"bluePrimary"];
            [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.3127,0.3290)] forKey:@"whitePoint"];
            [descriptor setValue:[NSValue valueWithSize:NSMakeSize(width*25.4/220,height*25.4/220)] forKey:@"sizeInMillimeters"];
            [descriptor setValue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0) forKey:@"queue"];
            s.display=[(id<ReachVirtualDisplay>)[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
            id mode=[(id<ReachVirtualDisplay>)[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width/2 height:height/2 refreshRate:60.0];
            id settings=[NSClassFromString(@"CGVirtualDisplaySettings") new];
            [settings setValue:@1 forKey:@"hiDPI"];[settings setValue:@[mode] forKey:@"modes"];
            BOOL applied=[(id<ReachVirtualDisplay>)s.display applySettings:settings];
            displayID=[(id<ReachVirtualDisplay>)s.display displayID];
            if(!applied||!displayID) @throw [NSException exceptionWithName:@"Unavailable" reason:@"macOS refused the virtual display. Connect an HDMI dummy plug and choose Mirror main display." userInfo:nil];
        }} else if(!CGDisplayIsActive(displayID)) {
            @throw [NSException exceptionWithName:@"Headless" reason:@"No active display. Use Match iPad, or connect an HDMI dummy plug." userInfo:nil];
        }
        NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:3];
        while(!CGDisplayIsActive(displayID) && [deadline timeIntervalSinceNow]>0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        if(!CGDisplayIsActive(displayID)) @throw [NSException exceptionWithName:@"Unavailable" reason:@"macOS has not activated this display. Reconnect, or use an HDMI dummy plug with Mirror main display." userInfo:nil];
        s.item=[[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
        s.item.button.title=@"Reach • Connected";
        NSMenu *menu=[NSMenu new];s.label=[[NSMenuItem alloc] initWithTitle:@"A device is viewing this Mac" action:nil keyEquivalent:@""];[menu addItem:s.label];
        NSMenuItem *disconnect=[[NSMenuItem alloc] initWithTitle:@"Disconnect remote desktop" action:@selector(disconnect:) keyEquivalent:@""];disconnect.target=s;[menu addItem:disconnect];s.item.menu=menu;
        emit(@{@"type":@"ready",@"display":[NSString stringWithFormat:@"%u",displayID],@"virtual":@(match)});
        [NSTimer scheduledTimerWithTimeInterval:1 target:s selector:@selector(watch:) userInfo:nil repeats:YES];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            char *line=NULL;size_t capacity=0;
            while(getline(&line,&capacity,stdin)>0) {
                if(strlen(line)>4096) break;
                NSDictionary *value=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
                dispatch_async(dispatch_get_main_queue(),^{
                    s.last=[NSDate date];NSString *label=value[@"label"];
                    if([label isKindOfClass:NSString.class]&&label.length<=160) {s.label.title=label;s.item.button.toolTip=label;}
                });
            }
            free(line);dispatch_async(dispatch_get_main_queue(),^{[s finish];});
        });
        signal(SIGTERM,SIG_IGN);
        dispatch_source_t termination=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(termination,^{[s finish];});dispatch_resume(termination);
        [NSApp run];s.display=nil;dispatch_source_cancel(termination);return 0;
    } @catch(NSException *e) {emit(@{@"error":e.reason?:@"Desktop preparation failed."});return 1;}
}}
