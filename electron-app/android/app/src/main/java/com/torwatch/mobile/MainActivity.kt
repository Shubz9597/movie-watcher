package com.torwatch.mobile

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    public override fun onCreate(savedInstanceState: Bundle?) {
        // App-local plugin registration (M1.4.5): TorWatchNative is implemented
        // inside the App module rather than as a separate npm plugin.
        registerPlugin(TorWatchNativePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
