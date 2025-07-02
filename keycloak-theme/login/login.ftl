<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=social.displayInfo displayWide=(realm.password && social.providers??); section>
    <#if section = "header">
        <div class="login-header">
            <h1>Welcome to Timey</h1>
            <p>Sign in to continue your drumming journey</p>
        </div>
    <#elseif section = "form">
        <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">
            <div class="form-group">
                <label for="username">Username or Email</label>
                <input tabindex="1" id="username" class="form-control" name="username" value="${(login.username!'')}"  type="text" autofocus autocomplete="off"
                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                />
            </div>

            <div class="form-group">
                <label for="password">Password</label>
                <input tabindex="2" id="password" class="form-control" name="password" type="password" autocomplete="off"
                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                />
            </div>

            <div class="form-options">
                <#if realm.rememberMe && !usernameEditDisabled??>
                    <div class="checkbox">
                        <label>
                            <#if login.rememberMe??>
                                <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox" checked> Remember me
                            <#else>
                                <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox"> Remember me
                            </#if>
                        </label>
                    </div>
                </#if>
            </div>

            <div class="form-actions">
                <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                <input tabindex="4" class="btn btn-primary btn-block btn-lg" name="login" id="kc-login" type="submit" value="Sign In"/>
            </div>
        </form>

        <div class="login-footer">
            <#if realm.password>
                <div><a href="${url.loginResetCredentialsUrl}">Forgot Password?</a></div>
            </#if>
            <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
                <div><a href="${url.registrationUrl}">Create Account</a></div>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout> 