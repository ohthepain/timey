<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=social.displayInfo displayWide=(realm.password && social.providers??); section>
    <#if section = "header">
        ${msg("errorTitle")}
    <#elseif section = "form">
        <div class="login-container">
            <div class="login-box">
                <div class="login-header">
                    <h1>Oops! Something went wrong</h1>
                    <p>We encountered an error while processing your request</p>
                </div>
                
                <div class="error-content">
                    <#if message?has_content>
                        <div class="alert alert-error">
                            ${message.summary?no_esc}
                        </div>
                    </#if>
                    
                    <#if error?has_content>
                        <div class="alert alert-error">
                            ${error}
                        </div>
                    </#if>
                    
                    <div class="form-actions">
                        <a href="${url.loginUrl}" class="btn btn-primary">
                            Back to Login
                        </a>
                    </div>
                </div>
            </div>
        </div>
    </#if>
</@layout.registrationLayout> 